// src/server.js
import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Api } from 'telegram';
import { getClient, checkSessionStatus, initializeSession, requestCode } from './client.js';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// helper: safely extract human-friendly title/name from an entity
function entityTitle(entity) {
  if (!entity) return null;
  // channels/groups have 'title'
  if (entity.title) return entity.title;
  // users may have firstName + lastName
  const fn = entity.firstName || entity.first_name || '';
  const ln = entity.lastName || entity.last_name || '';
  if (fn || ln) return `${fn} ${ln}`.trim();
  // fallback username
  return entity.username || entity.username?.toString?.() || `id:${entity.id || 'unknown'}`;
}

/**
 * GET /chats
 * Returns an array of dialogs (id, title, isChannel, isGroup, isUser, unreadCount)
 */
app.get('/chats', async (req, res) => {
  try {
    const client = await getClient();

    // fetch dialogs (recent dialogs). limit to 200 by default
    const dialogs = await client.getDialogs({ limit: 200 });

    // map dialogs into safe objects
    const list = dialogs.map(d => {
      const ent = d.entity || {};
      const isChannel = !!ent.broadcast || ent.className === 'Channel' || !!ent.megagroup || !!ent.title;
      const isGroup = !!ent.megagroup || (!!ent.title && !ent.broadcast);
      const isUser = ent.className === 'User' || (!!ent.firstName || !!ent.username && !ent.title);

      return {
        id: String(ent.id),                      // chat identifier (string)
        title: entityTitle(ent),
        isChannel: !!isChannel,
        isGroup: !!isGroup,
        isUser: !!isUser,
        unread: d.unreadCount || 0
      };
    });

    // filter to groups & channels only by default (but return everything)
    res.json({ ok: true, count: list.length, chats: list });
  } catch (err) {
    console.error('GET /chats error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /chats/:id/messages?limit=10
 * Returns last `limit` messages for the chat id.
 *
 * Note: :id must match the `id` field returned from /chats (string).
 */
app.get('/chats/:id/messages', async (req, res) => {
  try {
    const client = await getClient();
    const id = req.params.id;
    const limit = Math.min(100, Number(req.query.limit || 10)); // cap at 100
    if (!id) return res.status(400).json({ ok: false, error: 'Missing chat id' });

    // First, get dialogs to populate the entity cache
    // This ensures entities (especially users) are available with their access hashes
    const dialogs = await client.getDialogs({ limit: 200 });
    
    // Find the entity in dialogs by matching the id
    let entity = null;
    for (const dialog of dialogs) {
      const ent = dialog.entity;
      if (ent && String(ent.id) === id) {
        entity = ent;
        break;
      }
    }

    // If not found in dialogs, try to get it directly
    // This works better for channels/groups, but users need to be in dialogs
    if (!entity) {
      try {
        const numeric = Number(id);
        if (!isNaN(numeric)) {
          entity = await client.getEntity(numeric);
        } else {
          // Try as username
          entity = await client.getEntity(id);
        }
      } catch (e) {
        return res.status(404).json({ 
          ok: false, 
          error: `Chat with id ${id} not found. Make sure the chat exists in your recent dialogs.` 
        });
      }
    }

    // fetch last messages
    const msgs = await client.getMessages(entity, { limit });
    // map them
    const mapped = msgs.map(m => {
      // Handle date - could be Date object, number (timestamp), or undefined
      let dateStr = null;
      if (m.date) {
        if (m.date instanceof Date) {
          dateStr = m.date.toISOString();
        } else if (typeof m.date === 'number') {
          dateStr = new Date(m.date * 1000).toISOString(); // Convert Unix timestamp to ISO string
        } else if (typeof m.date === 'string') {
          dateStr = m.date;
        } else {
          // Try to convert to Date
          try {
            dateStr = new Date(m.date).toISOString();
          } catch (e) {
            dateStr = null;
          }
        }
      }

      return {
        id: String(m.id),
        senderId: m.senderId ? String(m.senderId?.userId ?? m.senderId) : null,
        senderName: (m.sender && (m.sender.username || m.sender.firstName || m.sender.lastName)) || null,
        text: m.message || '',
        date: dateStr,
        // include media info if present (type + size/filename)
        hasMedia: !!m.media,
        raw: m.toJSON ? m.toJSON() : {}
      };
    });

    res.json({ ok: true, chatId: id, chatTitle: entityTitle(entity), messages: mapped });
  } catch (err) {
    console.error('GET /chats/:id/messages error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/session/status
 * Check if session exists and is valid
 */
app.get('/api/session/status', async (req, res) => {
  try {
    const status = await checkSessionStatus();
    res.json({ ok: true, ...status });
  } catch (err) {
    console.error('GET /api/session/status error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/session/request-code
 * Request a code from Telegram (sends SMS)
 */
app.post('/api/session/request-code', async (req, res) => {
  try {
    const result = await requestCode();
    
    if (result.success) {
      res.json({ ok: true, message: result.message });
    } else {
      res.status(400).json({ ok: false, error: result.error });
    }
  } catch (err) {
    console.error('POST /api/session/request-code error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/session/initialize
 * Initialize a new session with SMS code and optional 2FA password
 * Body: { smsCode: string, twoFactorPassword?: string }
 */
app.post('/api/session/initialize', async (req, res) => {
  try {
    const { smsCode, twoFactorPassword } = req.body;
    
    if (!smsCode) {
      return res.status(400).json({ ok: false, error: 'SMS code is required' });
    }

    const result = await initializeSession(smsCode, twoFactorPassword || '');
    
    if (result.success) {
      res.json({ ok: true, message: result.message });
    } else {
      res.status(400).json({ ok: false, error: result.error });
    }
  } catch (err) {
    console.error('POST /api/session/initialize error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /chats/:id/send-message
 * Sends a message to the specified chat id/username.
 * * Body: { message: string }
 *
 * Note: :id must match the 'id' field returned from /chats (string) 
 * or be a valid username/phone number/chat ID.
 */
app.post('/chats/:id/send-message', async (req, res) => {
  try {
    const client = await getClient();
    const id = req.params.id; // Chat identifier (ID or username)
    const { message } = req.body;

    if (!id) {
      return res.status(400).json({ ok: false, error: 'Missing chat id' });
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ ok: false, error: 'Message content is required' });
    }

    // 1. Get the Telegram entity (InputPeer) from the ID/username
    // This handles resolving the 'peer' needed for the API call
    const entity = await client.getEntity(id);

    // 2. Send the message using client.invoke with Api.messages.SendMessage
    // Note: GramJS provides a higher-level client.sendMessage, but using 
    // client.invoke(new Api.messages.SendMessage) is a powerful, low-level way
    // to access all Telegram API features, matching your provided example.
    const result = await client.invoke(
      new Api.messages.SendMessage({
        // The peer obtained from client.getEntity is directly usable here
        peer: entity, 
        message: message,
        // The randomId is crucial to prevent message resending on retry
        // Use BigInt for compatibility, as required by the Telegram API layer
        randomId: BigInt(Math.floor(Math.random() * 0xFFFFFFFFFFFFFFF) + 1), 
        // Other optional flags can be added here as needed:
        // noWebpage: true,
      })
    );

    // 3. Respond with success and the result of the API call
    // The result is typically an Api.Updates object (Source 3.1)
    res.json({ ok: true, chatId: id, result: result });

  } catch (err) {
    // Check if the error is related to entity not found or invalid peer
    const errorMessage = err.message || 'Failed to send message';
    console.error('POST /chats/:id/send-message error', err);
    
    // Attempt to return a more user-friendly error
    if (errorMessage.includes('not found') || errorMessage.includes('PEER_ID_INVALID')) {
        res.status(404).json({ ok: false, error: `Chat with identifier ${req.params.id} not found or is invalid.` });
    } else {
        res.status(500).json({ ok: false, error: errorMessage });
    }
  }
});

// simple health
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Serve home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Initialize session file if it doesn't exist
function initializeSessionFile() {
  const SESSION_FILE = process.env.SESSION_FILE || 'session.txt';
  
  // Determine the session file path
  // client.js uses SESSION_FILE directly, which resolves relative to current working directory
  // So we should use the same resolution logic
  let sessionPath;
  if (path.isAbsolute(SESSION_FILE)) {
    sessionPath = SESSION_FILE;
  } else {
    // Relative path - resolve relative to current working directory (same as client.js)
    // This will typically be the project root when server is started with npm start
    sessionPath = path.resolve(process.cwd(), SESSION_FILE);
  }
  
  if (!fs.existsSync(sessionPath)) {
    try {
      // Ensure the directory exists
      const sessionDir = path.dirname(sessionPath);
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true, mode: 0o755 });
      }
      
      // Create empty session file with read/write permissions for owner (0o600)
      fs.writeFileSync(sessionPath, '', { mode: 0o600, flag: 'w' });
      console.log(`Created session file: ${sessionPath}`);
    } catch (err) {
      console.error(`Failed to create session file: ${err.message}`);
      // Don't exit, as the file will be created when session is initialized
    }
  }
}

// start server (no authentication required on startup)
initializeSessionFile();

app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
  console.log('Visit http://localhost:' + PORT + ' to manage your Telegram session');
});
