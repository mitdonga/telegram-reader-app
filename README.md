# Telegram MTProto App

A Node.js Express server that provides a REST API to interact with Telegram using the MTProto protocol via the `telegram` (GramJS) library.

## Features

- Get list of chats (channels, groups, users)
- Get messages from a specific chat
- RESTful API endpoints
- Session persistence

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Telegram API credentials
# Get these from https://my.telegram.org/apps
API_ID=your_api_id_here
API_HASH=your_api_hash_here

# Your phone number (with country code, e.g., +1234567890)
PHONE=your_phone_number_here

# Optional: Custom session file path (defaults to session.txt)
# SESSION_FILE=session.txt

# Optional: Server port (defaults to 3000)
# PORT=3000
```

**To get your API credentials:**
1. Go to https://my.telegram.org/apps
2. Log in with your phone number
3. Create a new application
4. Copy the `api_id` and `api_hash`

### 3. Run the Server

```bash
npm start
```

On first run, you'll be prompted to:
1. Enter the verification code sent to your Telegram account
2. Enter your 2FA password (if enabled)

The session will be saved to `session.txt` for future runs.

## API Endpoints

### GET /health
Health check endpoint.

**Response:**
```json
{
  "ok": true,
  "ts": "2024-01-01T00:00:00.000Z"
}
```

### GET /chats
Get list of all chats (channels, groups, and users).

**Response:**
```json
{
  "ok": true,
  "count": 10,
  "chats": [
    {
      "id": "123456789",
      "title": "Chat Name",
      "isChannel": false,
      "isGroup": true,
      "isUser": false,
      "unread": 5
    }
  ]
}
```

### GET /chats/:id/messages?limit=10
Get messages from a specific chat.

**Parameters:**
- `id` (path): Chat ID (from `/chats` endpoint)
- `limit` (query, optional): Number of messages to retrieve (default: 10, max: 100)

**Response:**
```json
{
  "ok": true,
  "chatId": "123456789",
  "chatTitle": "Chat Name",
  "messages": [
    {
      "id": "1",
      "senderId": "987654321",
      "senderName": "John Doe",
      "text": "Hello!",
      "date": "2024-01-01T00:00:00.000Z",
      "hasMedia": false,
      "raw": {}
    }
  ]
}
```

## Notes

- The session file (`session.txt`) contains your authentication token. Keep it secure and don't commit it to version control.
- The `.env` file is already in `.gitignore` to prevent accidental commits of sensitive data.
- On first login, the app will prompt for verification code and 2FA password interactively.

