// src/client.js
import fs from 'fs';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { ConnectionTCPFull } from 'telegram/network/index.js';
import dotenv from 'dotenv';
dotenv.config();

const API_ID = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const DC_ID = Number(process.env.DC_ID);
const DC_IP = process.env.DC_IP;
const DC_PORT = Number(process.env.DC_PORT);
const DC_USE_WSS = Boolean(process.env.DC_USE_WSS);
const PHONE = process.env.PHONE;
const SESSION_FILE = process.env.SESSION_FILE || 'session.txt';

// ensure env present
if (!API_ID || !API_HASH || !PHONE) {
  console.error('Missing API_ID, API_HASH or PHONE in .env');
  process.exit(1);
}
let client; // TelegramClient instance
let pendingAuth = null; // Store pending authentication state (phoneCodeHash)
let currentSessionString = null; // Track the session string currently in use

// Suppress timeout errors from Telegram client update loop
// These errors occur even when receiveUpdates is false, so we filter them out
// This handler is set up once when the module is loaded
let updateLoopErrorHandlerInstalled = false;

function installUpdateLoopErrorHandler() {
  if (updateLoopErrorHandlerInstalled) return;
  updateLoopErrorHandlerInstalled = true;
  
  const originalHandler = process.listeners('unhandledRejection').find(
    h => h.name === 'updateLoopErrorHandler'
  );
  
  if (!originalHandler) {
    process.on('unhandledRejection', function updateLoopErrorHandler(reason, promise) {
      // Check if it's a timeout error from the update loop
      if (reason && typeof reason === 'object') {
        const errorMessage = reason.message || reason.toString() || '';
        const errorStack = reason.stack || '';
        
        // Suppress timeout errors from the update loop
        // These occur in updates.js at _updateLoop even when receiveUpdates is false
        if (
          (errorMessage === 'TIMEOUT' || errorMessage.includes('TIMEOUT')) &&
          (errorStack.includes('updates.js') || errorStack.includes('_updateLoop') || 
           errorStack.includes('telegram/client/updates'))
        ) {
          // Silently ignore these timeout errors from the update loop
          // They don't affect functionality when receiveUpdates is false
          return;
        }
      }
      
      // For other unhandled rejections, let them propagate or be handled elsewhere
      // We don't log here to avoid duplicate logging
    });
  }
}

// Install the error handler when module loads
installUpdateLoopErrorHandler();

/**
 * Check if a session exists and is valid
 */
export async function checkSessionStatus() {
  // Check if session file exists
  if (!fs.existsSync(SESSION_FILE)) {
    return { exists: false, valid: false, status: 'no_session' };
  }

  const saved = fs.readFileSync(SESSION_FILE, 'utf8').trim();
  if (!saved) {
    return { exists: false, valid: false, status: 'no_session' };
  }

  // Try to connect and verify session
  let testClient = null;
  try {
    const stringSession = new StringSession(saved);
    testClient = new TelegramClient(stringSession, API_ID, API_HASH, {
      connection: ConnectionTCPFull,
      receiveUpdates: false, // Disable update loop for REST API usage
      timeout: 30000, // Set timeout to prevent hanging
    });

    // Try to connect
    await testClient.connect();
    
    // Try to get "me" to verify session is authorized
    // This is a lightweight call that will fail if session is invalid
    try {
      await testClient.getMe();
      return { exists: true, valid: true, status: 'active' };
    } catch (authErr) {
      // If getMe fails, session is likely invalid
      return { exists: true, valid: false, status: 'invalid', error: authErr.message };
    }
  } catch (err) {
    console.error('Session check error:', err.message);
    return { exists: true, valid: false, status: 'invalid', error: err.message };
  } finally {
    // Always disconnect the test client
    if (testClient && testClient.connected) {
      try {
        await testClient.disconnect();
      } catch (e) {
        // Ignore disconnect errors
      }
    }
  }
}

/**
 * Request a code from Telegram (sends SMS)
 */
export async function requestCode() {
  // Disconnect existing client if any
  if (client && client.connected) {
    try {
      await client.disconnect();
    } catch (e) {
      // Ignore disconnect errors
    }
    client = null;
    currentSessionString = null;
  }

  try {
    // Delete existing session if any
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }

    const stringSession = new StringSession('');
    const newClient = new TelegramClient(stringSession, API_ID, API_HASH, {
      receiveUpdates: false, // Disable update loop for REST API usage
      timeout: 30000, // Set timeout to prevent hanging
      connectionRetries: 5,
      useWSS: DC_USE_WSS
    });

    newClient.session.setDC(DC_ID,DC_IP,DC_PORT)
    
    // Connect first
    await newClient.connect();

    // Request code - this will send SMS
    // Using the auth API directly
    const { Api } = await import('telegram/tl/index.js');
    const result = await newClient.invoke(
      new Api.auth.SendCode({
        phoneNumber: PHONE,
        apiId: API_ID,
        apiHash: API_HASH,
        settings: new Api.CodeSettings({}),
      })
    );

    // Store the phone code hash for later use
    // The result should have phoneCodeHash property
    const phoneCodeHash = result.phoneCodeHash;
    
    if (!phoneCodeHash) {
      throw new Error('Failed to get phone code hash from Telegram');
    }
    
    pendingAuth = {
      client: newClient,
      phoneCodeHash: phoneCodeHash,
    };

    console.log('Code requested and SMS sent to', PHONE);
    console.log('Phone code hash received:', phoneCodeHash.substring(0, 10) + '...');
    return { success: true, message: 'Code sent successfully. Please check your Telegram.' };
  } catch (err) {
    console.error('Request code error:', err);
    return { success: false, error: err.message || 'Failed to request code' };
  }
}

/**
 * Initialize a new session with provided SMS code and 2FA password
 */
export async function initializeSession(smsCode, twoFactorPassword = '') {
  if (!pendingAuth || !pendingAuth.client) {
    return { success: false, error: 'Please request a code first by clicking "Request Code"' };
  }

  try {
    const newClient = pendingAuth.client;
    const phoneCodeHash = pendingAuth.phoneCodeHash;

    // Sign in with the code
    let user;
    try {
      user = await newClient.invoke(
        new (await import('telegram/tl/index.js')).Api.auth.SignIn({
          phoneNumber: PHONE,
          phoneCodeHash: phoneCodeHash,
          phoneCode: smsCode,
        })
      );
    } catch (err) {
      // If sign in fails, might need 2FA password
      if (err.errorMessage === 'SESSION_PASSWORD_NEEDED' || err.message?.includes('PASSWORD')) {
        if (!twoFactorPassword) {
          return { success: false, error: '2FA password is required' };
        }

        // Get password info
        const passwordInfo = await newClient.invoke(
          new (await import('telegram/tl/index.js')).Api.account.GetPassword()
        );

        // Check password
        const { Api } = await import('telegram/tl/index.js');
        const { computeCheck } = await import('telegram/Password.js');
        const passwordCheck = await computeCheck(passwordInfo, twoFactorPassword);

        // Sign in with password
        user = await newClient.invoke(
          new Api.auth.CheckPassword({
            password: passwordCheck,
          })
        );
      } else {
        throw err;
      }
    }

    // Save the new session
    const newSession = newClient.session.save();
    fs.writeFileSync(SESSION_FILE, newSession, { mode: 0o600 });
    console.log('Saved new session to', SESSION_FILE);

    // Disconnect old client if it exists
    if (client && client.connected && client !== newClient) {
      try {
        await client.disconnect();
      } catch (e) {
        // Ignore disconnect errors
      }
    }

    // Set the global client and update tracked session
    client = newClient;
    currentSessionString = newSession;
    pendingAuth = null;

    return { success: true, message: 'Session initialized successfully' };
  } catch (err) {
    console.error('Session initialization error:', err);
    // Clean up on error
    if (pendingAuth && pendingAuth.client) {
      try {
        await pendingAuth.client.disconnect();
      } catch (e) {
        // Ignore disconnect errors
      }
    }
    pendingAuth = null;
    if (fs.existsSync(SESSION_FILE)) {
      try {
        fs.unlinkSync(SESSION_FILE);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    return { success: false, error: err.message || 'Failed to initialize session' };
  }
}

/**
 * Get or create client instance (only if session is already valid)
 */
export async function getClient() {
  // Check if session file exists and get its content
  let saved = '';
  if (fs.existsSync(SESSION_FILE)) {
    saved = fs.readFileSync(SESSION_FILE, 'utf8').trim();
  }

  // If no session file, throw error
  if (!saved) {
    throw new Error('No valid session. Please initialize a session first.');
  }

  // Check if we have a cached client and if the session matches
  if (client && client.connected) {
    // Check if the session file has changed
    if (currentSessionString === saved) {
      try {
        // Verify client is still authorized by trying to get "me"
        await client.getMe();
        return client;
      } catch (err) {
        // Client is not valid, reset it
        console.log('Cached client is no longer valid, reloading...');
        client = null;
        currentSessionString = null;
      }
    } else {
      // Session file has changed, disconnect old client and reload
      console.log('Session file has changed, reloading client...');
      try {
        await client.disconnect();
      } catch (e) {
        // Ignore disconnect errors
      }
      client = null;
      currentSessionString = null;
    }
  }

  // Check if we have a valid session
  const status = await checkSessionStatus();
  if (!status.valid) {
    throw new Error('No valid session. Please initialize a session first.');
  }

  // Load and connect with existing session
  const stringSession = new StringSession(saved);
  client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connection: ConnectionTCPFull,
    receiveUpdates: false, // Disable update loop for REST API usage
    timeout: 30000, // Set timeout to prevent hanging
  });

  await client.connect();
  
  // Verify authorization by getting "me"
  try {
    await client.getMe();
  } catch (err) {
    throw new Error('Session is not authorized. Please initialize a new session.');
  }

  // Update the tracked session string
  currentSessionString = saved;

  return client;
}
