import express from 'express';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { 
  makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion,
  WASocket,
  downloadMediaMessage,
  getUrlInfo
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import archiver from 'archiver';

const app = express();
const port = 3000;
const host = '0.0.0.0';

app.use(cors());
app.use(express.json());

// Bot Config Management
const CONFIG_FILE = path.join(process.cwd(), 'bot_config.json');
const AUTH_DIR = path.join(process.cwd(), 'auth_info_baileys');
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

interface Broadcast {
  id: string;
  message: string;
  interval: number; // minutes
  imageUrl?: string;
  lastSent?: number;
}

interface BotConfig {
  adminGroupId: string;
  broadcasts: Broadcast[];
  isActive: boolean;
  guardEnabled: boolean;
  seenInvites: string[];
}

let botConfig: BotConfig = {
  adminGroupId: '',
  broadcasts: [],
  isActive: false,
  guardEnabled: false,
  seenInvites: []
};

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      botConfig = { ...botConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
      if (!botConfig.seenInvites) botConfig.seenInvites = [];
    } catch (e) {
      console.error('Error loading config:', e);
    }
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig, null, 2));
}

loadConfig();

// WhatsApp Bot Logic
let sock: WASocket | null = null;
let qrCode: string | null = null;
let connectionStatus: 'connected' | 'disconnected' | 'waiting_for_qr' = 'disconnected';

async function safeSendMessage(jid: string, content: any, options?: any) {
  try {
    if (!sock || connectionStatus !== 'connected') {
      console.error(`[SEND] Failed: Bot not connected. JID: ${jid}`);
      return null;
    }
    const result = await sock.sendMessage(jid, content, options);
    console.log(`[SEND] Success to ${jid}`);
    return result;
  } catch (err) {
    console.error(`[SEND] Error to ${jid}:`, err);
    return null;
  }
}

const groupAdminsCache: Record<string, { admins: string[], timestamp: number }> = {};

async function isUserAdmin(groupId: string, userId: string) {
  if (!sock) return false;
  const now = Date.now();
  if (!groupAdminsCache[groupId] || now - groupAdminsCache[groupId].timestamp > 60000) {
    try {
      const meta = await sock.groupMetadata(groupId);
      const admins = meta.participants.filter(p => p.admin).map(p => p.id);
      groupAdminsCache[groupId] = { admins, timestamp: now };
    } catch (_e) {
      return false;
    }
  }
  // Normalize userId to base JID (remove device ID like :1 and proper domain)
  let baseUserId = userId.split(':')[0];
  if (baseUserId.includes('@')) {
    baseUserId = baseUserId.split('@')[0];
  }
  baseUserId = baseUserId + '@s.whatsapp.net';
  
  return groupAdminsCache[groupId]?.admins.includes(baseUserId);
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  
  let version: [number, number, number] = [2, 3000, 1015901307];
  try {
    const res = await fetchLatestBaileysVersion();
    version = res.version;
  } catch (e) {
    console.error('[CONN] Failed to fetch latest Baileys version, using fallback:', e);
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 15000,
    defaultQueryTimeoutMs: 60000,
    getMessage: async (key) => {
      return { conversation: '' };
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('[CONN] QR Code received');
      qrCode = await QRCode.toDataURL(qr);
      connectionStatus = 'waiting_for_qr';
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      connectionStatus = 'disconnected';
      qrCode = null;

      console.log('[CONN] Connection closed. Reconnecting:', shouldReconnect, 'Status Code:', statusCode, 'Error:', lastDisconnect?.error);

      if (statusCode === 403 || statusCode === 429 || statusCode === 401 || statusCode === 408) {
         console.log(`[CONN] Status ${statusCode}. Clearing auth and waiting before reconnect...`);
         if (fs.existsSync(AUTH_DIR)) {
           fs.rmSync(AUTH_DIR, { recursive: true, force: true });
         }
         setTimeout(connectToWhatsApp, 5000); // Wait 5 seconds
      } else if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        // Logged out, clear auth
        console.log('[CONN] Logged out. Clearing auth...');
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        setTimeout(connectToWhatsApp, 5000);
      }
    } else if (connection === 'open') {
      console.log('[CONN] Connection opened successfully!');
      connectionStatus = 'connected';
      qrCode = null;
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    const msg = m.messages[0];
    
    const from = msg.key.remoteJid || '';
    console.log(`[RECEIVE] Message from ${from}`);

    if (!msg.message || msg.key.fromMe) return;
    
    // Improved text extraction
    let text = '';
    if (msg.message.conversation) {
      text = msg.message.conversation;
    } else if (msg.message.extendedTextMessage?.text) {
      text = msg.message.extendedTextMessage.text;
    } else if (msg.message.imageMessage?.caption) {
      text = msg.message.imageMessage.caption;
    } else if (msg.message.videoMessage?.caption) {
      text = msg.message.videoMessage.caption;
    } else if (msg.message.viewOnceMessageV2?.message?.imageMessage?.caption) {
      text = msg.message.viewOnceMessageV2.message.imageMessage.caption;
    } else if (msg.message.viewOnceMessageV2?.message?.videoMessage?.caption) {
      text = msg.message.viewOnceMessageV2.message.videoMessage.caption;
    }

    const isGroup = from.endsWith('@g.us');
    const sender = isGroup ? (msg.key.participant || msg.key.remoteJid || '') : from;
    
    if (text) {
      console.log(`[MSG] From: ${from} | Text: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);
      // Do not await readMessages as it can block the event queue if network lags
      sock.readMessages([msg.key]).catch(e => console.error('Error marking as read:', e));
    }

    const cmd = text.trim().toLowerCase();

    // Invite Detection (Find Search Groups) - Asynchronous to avoid blocking message queue!
    if (text && botConfig.adminGroupId && !cmd.startsWith('!')) {
      const inviteRegex = /chat\.whatsapp\.com\/([0-9a-zA-Z]{20,26})/g;
      const matches = Array.from(text.matchAll(inviteRegex));
      
      for (const match of matches) {
        const code = match[1];
        if (!botConfig.seenInvites.includes(code)) {
          // Asynchronously resolve to avoid blocking the event loop
          Promise.resolve().then(async () => {
            try {
              const groupMeta = await sock?.groupGetInviteInfo(code);
              if (groupMeta) {
                const subject = groupMeta.subject.toLowerCase();
                if (subject.includes('search')) {
                  botConfig.seenInvites.push(code);
                  saveConfig();
                  
                  await safeSendMessage(botConfig.adminGroupId, { 
                    text: `🔍 *Yeni Search Grubu Bulundu!*\n\n✅ *Grup:* ${groupMeta.subject}\n🔗 https://chat.whatsapp.com/${code}\n\n_(Ban riskine karşı otomatik katılma kapalıdır, manuel katılabilirsiniz.)_` 
                  });
                }
              }
            } catch (e) {
              console.error('[INVITE] Error checking invite:', e);
            }
          });
        }
      }
    }

    // SADECE "botConfig.adminGroupId" HENÜZ AYARLANMADIYSA BU KOMUT ÇALIŞSIN
    if (cmd === '!adminburasi') {
      if (isGroup) {
        if (!botConfig.adminGroupId) {
          botConfig.adminGroupId = from;
          saveConfig();
          safeSendMessage(from, { text: '✅ Bu grup yönetim grubu olarak ayarlandı.' }, { quoted: msg });
        } else {
          // Eğer önceden ayarlandıysa uyarı ver, güvenliği sağla
          safeSendMessage(from, { text: '❌ Admin grubu zaten ayarlanmış! Değiştirmek için web paneli kullanın.' }, { quoted: msg });
        }
      }
      return; // Diğer komutlara geçmeye gerek yok
    }

    // BUNDAN SONRAKİ TÜM KOMUTLAR SADECE "ADMIN GRUBUNDA" İŞLEME ALINACAK
    if (from !== botConfig.adminGroupId) {
      return;
    }

    // Bot güvenliği: Komutlara insan gibi biraz gecikmeli yanıt ver
    if (cmd.startsWith('!')) {
      sock.sendPresenceUpdate('composing', from).catch(() => {});
      const randomDelay = Math.floor(Math.random() * 2000) + 1500; // 1.5 - 3.5 saniye bekle
      await new Promise(resolve => setTimeout(resolve, randomDelay));
      sock.sendPresenceUpdate('paused', from).catch(() => {});
    }

    if (cmd === '!yardım' || cmd === '!yardim' || cmd === 'yardım' || cmd === 'yardim') {
      const helpText = `🤖 *WhatsApp Duyuru Botu Yardım Menüsü*

📌 *Komutlar:*
• !adminburasi : Yazılan grubu yönetim grubu yapar.
• !otogönder [mesaj] [dakika] : Yeni bir otomatik duyuru ekler.
• !botaktif : Botu aktif hale getirir.
• !botpasif : Botu durdurur.
• !durum : Botun çalışma durumunu gösterir.
• !liste : Aktif duyuruları listeler.
• !sil [no] : Belirtilen numaradaki duyuruyu siler.
• !temizle : Tüm duyuruları siler.
• !yedek : Bot dosyalarını ZIP olarak gönderir.
• !yardım : Bu menüyü gösterir.

💡 *Örnek:* !otogönder Merhaba Arkadaşlar 10
(10 dakikada bir "Merhaba Arkadaşlar" mesajı gönderir)`;
      safeSendMessage(from, { text: helpText }, { quoted: msg });
    }

    if (cmd === '!durum') {
      const statusText = `🤖 *Bot Durum Raporu*

📡 *Bağlantı:* ${connectionStatus === 'connected' ? '✅ Bağlı' : '❌ Bağlı Değil'}
⚙️ *Çalışma Durumu:* ${botConfig.isActive ? '🚀 Aktif' : '😴 Pasif'}
📢 *Aktif Duyuru Sayısı:* ${botConfig.broadcasts.length}
👥 *Yönetim Grubu:* ${botConfig.adminGroupId ? '✅ Ayarlandı' : '❌ Ayarlanmadı'}`;
      safeSendMessage(from, { text: statusText }, { quoted: msg });
    }

    if (cmd === '!botaktif') {
      botConfig.isActive = true;
      saveConfig();
      safeSendMessage(from, { text: '🚀 Bot AKTİF hale getirildi. Duyurular gönderilmeye başlanacak.' }, { quoted: msg });
    }

    if (cmd === '!botpasif') {
      botConfig.isActive = false;
      saveConfig();
      safeSendMessage(from, { text: '😴 Bot PASİF hale getirildi. Duyurular durduruldu.' }, { quoted: msg });
    }

    if (cmd === '!temizle') {
      botConfig.broadcasts = [];
      saveConfig();
      safeSendMessage(from, { text: '🗑️ Tüm duyurular temizlendi.' }, { quoted: msg });
    }

    if (cmd === '!yedek') {
      safeSendMessage(from, { text: '⏳ Bot dosyaları sıkıştırılıyor, lütfen bekleyin...' }, { quoted: msg });
      try {
        const zipPath = path.join(process.cwd(), 'yedek.zip');
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        output.on('close', async () => {
          await safeSendMessage(from, { 
            document: { url: zipPath }, 
            mimetype: 'application/zip', 
            fileName: 'bot-yedek.zip',
            caption: '📦 İşte botun tüm dosyaları! Başka bir hesaptan veya cihazdan kurabilirsiniz.'
          }, { quoted: msg });
          fs.unlinkSync(zipPath);
        });
        
        archive.on('error', (err) => {
          throw err;
        });

        archive.pipe(output);
        
        archive.glob('**/*', {
          cwd: process.cwd(),
          dot: true,
          ignore: ['node_modules/**', 'dist/**', '.git/**', 'auth_info_baileys/**', 'uploads/**', 'yedek.zip', '.env']
        });

        archive.finalize();
      } catch (err) {
        console.error('Yedek alma hatası:', err);
        safeSendMessage(from, { text: '❌ Yedek alınırken bir hata oluştu.' }, { quoted: msg });
      }
    }

    if (cmd === '!liste') {
      if (botConfig.broadcasts.length === 0) {
        safeSendMessage(from, { text: '📝 Şu an kayıtlı duyuru bulunmuyor.' }, { quoted: msg });
        return;
      }
      let listText = '📝 *Aktif Duyurular Listesi*\n\n';
      botConfig.broadcasts.forEach((b, i) => {
        listText += `*${i + 1}* - ⏱️ ${b.interval} dk\n💬 ${b.message.substring(0, 100)}${b.message.length > 100 ? '...' : ''}\n\n`;
      });
      listText += `💡 Silmek için: *!sil [no]*`;
      safeSendMessage(from, { text: listText }, { quoted: msg });
    }

    if (cmd.startsWith('!sil ')) {
      const index = parseInt(cmd.split(' ')[1]) - 1;
      if (isNaN(index) || index < 0 || index >= botConfig.broadcasts.length) {
        safeSendMessage(from, { text: '❌ Geçersiz duyuru numarası! Liste için !liste yazın.' }, { quoted: msg });
        return;
      }
      const removed = botConfig.broadcasts.splice(index, 1);
      saveConfig();
      safeSendMessage(from, { text: `✅ Duyuru silindi: ${removed[0].message.substring(0, 30)}...` }, { quoted: msg });
    }

    if (cmd.startsWith('!otogönder ')) {
      const parts = text.split(' ');
      if (parts.length < 3) {
        await safeSendMessage(from, { text: '❌ Hatalı kullanım! Örnek: !otogönder Mesajınız 10' }, { quoted: msg });
        return;
      }
      
      const minute = parseInt(parts[parts.length - 1]);
      if (isNaN(minute)) {
        await safeSendMessage(from, { text: '❌ Dakika geçersiz! Örnek: !otogönder Mesajınız 10' }, { quoted: msg });
        return;
      }

      let message = parts.slice(1, -1).join(' ');
      
      // Format link to be on a new line for better preview generation
      const linkMatch = message.match(/(https?:\/\/[^\s]+)/);
      if (linkMatch) {
        const link = linkMatch[1];
        // If the link is not already preceded by a newline, add one
        if (!message.includes('\n' + link) && !message.startsWith(link)) {
          message = message.replace(link, '\n' + link);
        }
      }
      
      let imageUrl: string | undefined = undefined;
      const imageMessage = msg.message?.imageMessage;
      
      if (imageMessage) {
        try {
          const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            { },
            { 
              logger: pino({ level: 'silent' }),
              reuploadRequest: sock!.updateMediaMessage
            }
          );
          const id = Math.random().toString(36).substr(2, 9);
          const filePath = path.join(UPLOADS_DIR, `img_${id}.jpg`);
          fs.writeFileSync(filePath, buffer);
          imageUrl = filePath;
          console.log(`[UPLOAD] Image saved to ${filePath}`);
        } catch (err) {
          console.error('[UPLOAD] Failed to download image:', err);
        }
      }
      
      botConfig.isActive = true; // Auto-activate on new broadcast
      botConfig.broadcasts.push({
        id: Math.random().toString(36).substr(2, 9),
        message: message,
        interval: minute,
        imageUrl: imageUrl
      });
      saveConfig();

      safeSendMessage(from, { text: `✅ Duyuru eklendi ve Bot AKTİF edildi!\n📝 Mesaj: ${message}\n⏱️ Süre: ${minute} dakika${imageUrl ? '\n📸 Fotoğraf eklendi!' : ''}` }, { quoted: msg });
    }
  });
}

connectToWhatsApp();

// Broadcast Loop
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function runBroadcasts() {
  console.log('Broadcast loop started');
  while (true) {
    try {
      if (botConfig.isActive && connectionStatus === 'connected' && sock) {
        // Human-like: Randomly update presence to 'available'
        if (Math.random() > 0.7) {
          await sock.sendPresenceUpdate('available');
        }
        
        const now = Date.now();
        let groupIds: string[] | null = null;

        for (const broadcast of botConfig.broadcasts) {
          const intervalMs = broadcast.interval * 60 * 1000;
          if (!broadcast.lastSent || now - broadcast.lastSent >= intervalMs) {
            
            let groupsRaw: any = null;

            // Fetch groups only once if needed
            if (!groupIds) {
              console.log(`[BROADCAST] Fetching participating groups...`);
              groupsRaw = await sock.groupFetchAllParticipating();
              groupIds = Object.keys(groupsRaw);
              console.log(`[BROADCAST] Found ${groupIds.length} groups.`);
            }

            console.log(`[BROADCAST] Sending: "${broadcast.message.substring(0, 30)}..."`);
            
            let urlInfo: any = undefined;
            if (!broadcast.imageUrl && broadcast.message.match(/https?:\/\//)) {
              try {
                console.log(`[BROADCAST] Fetching link preview...`);
                urlInfo = await getUrlInfo(broadcast.message, {
                  thumbnailWidth: 200,
                  fetchOpts: { timeout: 15000 }
                });
                if (urlInfo) console.log(`[BROADCAST] Link preview generated successfully.`);
              } catch (e) {
                console.error('[BROADCAST] Link preview fetch failed:', e);
              }
            }
            
            for (const gid of groupIds) {
              try {
                // If group logic allows, check if it's strictly an 'announce' / 'admin-only' group.
                // If announce is true, non-admins cannot send messages. We must check if we're admin.
                if (groupsRaw && groupsRaw[gid]) {
                  if (groupsRaw[gid].announce) {
                    const botId = sock.user?.id;
                    if (botId) {
                      const isBotAdmin = await isUserAdmin(gid, botId);
                      if (!isBotAdmin) {
                        console.log(`[BROADCAST] Skipping ${gid}: It is an 'Admin-Only' group and bot is not an admin.`);
                        continue;
                      }
                    }
                  }
                }

                // Anti-Spam: Attach random hidden characters to break exact message matches
                const invisibleChars = '\u200B\u200C\u200D\uFEFF'; 
                let randomSalt = '';
                for(let i=0; i<Math.floor(Math.random() * 5) + 3; i++) {
                   randomSalt += invisibleChars.charAt(Math.floor(Math.random() * invisibleChars.length));
                }
                const safeMessageText = broadcast.message + '\n' + randomSalt;

                // Human-like behavior: Presence and Typing
                sock.sendPresenceUpdate('composing', gid).catch(() => {});
                const typingDelay = Math.min(Math.max(broadcast.message.length * 30, 1500), 4000);
                await delay(typingDelay + Math.random() * 1000);
                sock.sendPresenceUpdate('paused', gid).catch(() => {});

                if (broadcast.imageUrl) {
                  await safeSendMessage(gid, { 
                    image: { url: broadcast.imageUrl }, 
                    caption: safeMessageText 
                  });
                } else {
                  if (urlInfo) {
                    await safeSendMessage(gid, { text: safeMessageText, ...urlInfo });
                  } else {
                    await safeSendMessage(gid, { text: safeMessageText });
                  }
                }
                
                // PERFORMANCE & ANTI-BAN SAFETY: 10-25 seconds random delay between groups
                const randomGroupDelay = Math.floor(Math.random() * 15000) + 10000; 
                console.log(`[BROADCAST] Waiting ${Math.round(randomGroupDelay/1000)}s before next group...`);
                await delay(randomGroupDelay);
              } catch (err) {
                console.error(`[BROADCAST] Failed to send to ${gid}:`, err);
              }
            }

            broadcast.lastSent = now;
            saveConfig();
          }
        }
      }
    } catch (e) {
      console.error('Broadcast loop error:', e);
    }
    await delay(30000); // 30 seconds between loop checks
  }
}

runBroadcasts();

// API Routes
app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    qr: qrCode,
    config: botConfig
  });
});

app.post('/api/config', (req, res) => {
  const { adminGroupId, isActive } = req.body;
  if (adminGroupId !== undefined) botConfig.adminGroupId = adminGroupId;
  if (isActive !== undefined) botConfig.isActive = isActive;
  saveConfig();
  res.json({ success: true, config: botConfig });
});

app.post('/api/broadcasts', (req, res) => {
  const { action, broadcast } = req.body;
  if (action === 'add') {
    botConfig.broadcasts.push({
      id: Math.random().toString(36).substr(2, 9),
      message: broadcast.message,
      interval: broadcast.interval,
    });
  } else if (action === 'delete') {
    botConfig.broadcasts = botConfig.broadcasts.filter(b => b.id !== broadcast.id);
  }
  saveConfig();
  res.json({ success: true, config: botConfig });
});

app.post('/api/logout', async (req, res) => {
  if (sock) {
    try {
      sock.ws.close();
    } catch (e) {
      console.error('Logout error:', e);
    }
  }
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }
  res.json({ success: true });
});

app.post('/api/reset', async (req, res) => {
  console.log('[RESET] Manual reset requested');
  if (sock) {
    try { sock.ws.close(); } catch(e) {}
    sock = null;
  }
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }
  connectionStatus = 'disconnected';
  qrCode = null;
  connectToWhatsApp();
  res.json({ success: true });
});

app.get('/api/ping', (req, res) => {
  res.send('pong');
});

// Vite Integration
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), 'dist')));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
    });
  }

  app.listen(port, host, () => {
    console.log(`Server running at http://${host}:${port}`);
  });
}

startServer();
