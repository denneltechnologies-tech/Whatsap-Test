# Evolution API - Custom AI Chatbot Platform Deployment & Operations Guide

This guide covers how to deploy, configure, and manage the **Custom AI Chatbot & Knowledge Base Platform** integrated into Evolution API, specifically optimized for **Dokploy VPS** deployment.

---

## 1. Architectural Overview

The Custom AI Chatbot is built as a first-class modular engine directly inside Evolution API. It operates without requiring external services like Dify to be deployed separately, while offering a complete Dify-like experience for business customer support.

```mermaid
graph TD
    WhatsApp[WhatsApp Users] -->|Incoming Messages| Baileys[Baileys Channel Provider]
    Baileys -->|Message Event| Controller[ChatbotController.emit]
    Controller -->|Inbound Dispatch| CustomAI[CustomAiService]
    
    subgraph Custom AI Engine
        CustomAI --> Dedup[DeduplicationService (LRU + DB Lock)]
        CustomAI --> HumanCheck{Human Takeover Active?}
        HumanCheck -->|Yes| Suppress[Suppress AI Reply]
        HumanCheck -->|No| RAG[RAG Retrieval Engine]
        RAG --> KnowledgeChunks[(PostgreSQL / pgvector)]
        RAG --> Embeddings[Pluggable Embeddings API]
        CustomAI --> LLM[OpenAI-Compatible LLM]
    end
    
    LLM --> Dispatch[sendMessageController.sendTextMessage]
    Dispatch --> Baileys
    Baileys -->|WhatsApp Reply| WhatsApp

    subgraph Administrative Web UI
        Admin[Administrator / Support Staff] --> Dashboard[Glassmorphic AI Dashboard (/dashboard)]
        Dashboard --> Overview[WhatsApp Status & Metrics]
        Dashboard --> Settings[AI Assistant Configuration]
        Dashboard --> KnowledgeBase[Document Ingestion & FAQ Manager]
        Dashboard --> Inbox[Live Conversation Inbox & Human Takeover]
        Dashboard --> QR[Instance QR Code Pairing]
    end
```

---

## 2. Key Features

1. **Native Evolution API Integration**:
   - Zero breaking changes to upstream Baileys, WhatsApp Business API, Webhooks, or REST endpoints.
   - Incoming messages are intercepted via `ChatbotController.emit()`.
   - Replies are dispatched using Evolution API's internal `sendMessageController` with authentic typing state (`composing` & `paused`) and human-like typing delays.

2. **Dify-Like Management Dashboard**:
   - Accessible at `/dashboard` and `/ai-dashboard`.
   - Dark-mode, glassmorphic responsive UI.
   - Real-time instance switcher, connection state badges, and live QR code pairing.
   - Comprehensive conversational metrics, response counts, and knowledge statistics.

3. **Multi-Source Knowledge Base & RAG Engine**:
   - **Supported File Types**: PDF, Word (`.docx`), Markdown (`.md`), Plain Text (`.txt`).
   - **Web Ingestion**: Direct URL scraping with strict Server-Side Request Forgery (SSRF) prevention (blocks `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.169.254`, `::1`).
   - **Business Data Editor**: Direct storage of FAQs, product catalogs, refund policies, and opening hours.
   - **Pluggable Vector Storage**: Native JSON vector similarity with dynamic cosine scoring on standard PostgreSQL 15, and native acceleration when `pgvector` is enabled.
   - **Pluggable Embeddings**: Supports OpenAI (`text-embedding-3-small`, `text-embedding-3-large`), OpenRouter, Groq, Ollama, custom endpoints, and a deterministic 384-dimensional fallback when offline.

4. **Human Takeover & Live Conversation Inbox**:
   - View conversations, last messages, and unread counts.
   - Color-coded messages: Customer messages, AI-generated responses (with blue badge), and Human agent responses (with green badge).
   - Instant Pause / Resume AI toggle per conversation.
   - Direct human reply input that dispatches messages to WhatsApp and automatically pauses AI to prevent race conditions.
   - Automatic takeover trigger when customers type keywords (e.g. `human`, `agent`, `atendente`, `humano`, `suporte`).

5. **Deduplication & Enterprise Reliability**:
   - Two-tier deduplication (high-speed LRU memory cache + persistent DB check).
   - In-flight mutex locks per message ID to prevent duplicate customer replies under webhook retries or burst messaging.

---

## 3. Dokploy VPS Deployment

### Prerequisites
- A Dokploy VPS with Docker and Traefik configured.
- A domain or subdomain pointed to your Dokploy server (e.g. `whatsapp.yourdomain.com`).
- A PostgreSQL database (either created via Dokploy's Managed Database or the included `evolution-postgres` container).
- A Redis instance (either created via Dokploy or the included `evolution_redis` container).

---

### Option A: Deploy via Dokploy Docker Compose (Recommended)

1. Open your **Dokploy Dashboard**.
2. Navigate to your **Project** and click **Create Service** -> **Compose**.
3. Name your service (e.g. `evolution-ai`).
4. Paste the following production `docker-compose.yaml` into the Compose editor:

```yaml
version: "3.8"

services:
  api:
    container_name: evolution_api
    build:
      context: .
      dockerfile: Dockerfile
    image: evolution-api-ai:latest
    restart: always
    depends_on:
      redis:
        condition: service_healthy
      evolution-postgres:
        condition: service_healthy
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - evolution_instances:/evolution/instances
      - evolution_uploads:/evolution/public/uploads
    networks:
      - evolution-net
      - dokploy-network
    env_file:
      - .env
    expose:
      - "8080"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  redis:
    container_name: evolution_redis
    image: redis:alpine
    restart: always
    command: >
      redis-server --port 6379 --appendonly yes
    volumes:
      - evolution_redis:/data
    networks:
      evolution-net:
        aliases:
          - evolution-redis
      dokploy-network:
        aliases:
          - evolution-redis
    expose:
      - "6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  evolution-postgres:
    container_name: evolution_postgres
    image: pgvector/pgvector:pg15
    restart: always
    env_file:
      - .env
    command:
      - postgres
      - -c
      - max_connections=1000
      - -c
      - listen_addresses=*
    environment:
      - POSTGRES_DB=${POSTGRES_DATABASE}
      - POSTGRES_USER=${POSTGRES_USERNAME}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - evolution-net
      - dokploy-network
    expose:
      - "5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USERNAME:-evolution} -d ${POSTGRES_DATABASE:-evolution}"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  evolution_instances:
  evolution_redis:
  postgres_data:
  evolution_uploads:

networks:
  evolution-net:
    name: evolution-net
    driver: bridge
  dokploy-network:
    external: true
```

5. In Dokploy, go to **Environment** tab and fill in your variables (see Section 4 below).
6. In Dokploy, go to **Domains** tab and add your domain:
   - **Host**: `whatsapp.yourdomain.com`
   - **Path**: `/`
   - **Port**: `8080`
   - **HTTPS**: Enabled (Let's Encrypt SSL)
7. Click **Deploy**. Dokploy will pull the repository, build the Docker container, run migrations automatically via `deploy_database.sh`, and start Evolution API with health checks active.

---

### Option B: Deploy as a Dokploy Application (Direct Git Repo)

1. In Dokploy, click **Create Service** -> **Application**.
2. Select your Git provider (GitHub / GitLab) or repository URL.
3. Build Type: **Dockerfile**.
4. Port: `8080`.
5. Set Healthcheck path: `/`.
6. Add Persistent Volumes:
   - `/evolution/instances` (Named volume: `evolution_instances`)
   - `/evolution/public/uploads` (Named volume: `evolution_uploads`)
7. Add Environment Variables (see Section 4).
8. Connect to an existing PostgreSQL database and Redis on the `dokploy-network`.
9. Click **Deploy**.

---

## 4. Environment Variables Reference

Configure these in Dokploy's **Environment** tab or in your `.env` file:

### Server & Security
| Variable | Default | Description |
|---|---|---|
| `SERVER_URL` | `https://whatsapp.yourdomain.com` | Public HTTPS domain URL |
| `SERVER_PORT` | `8080` | Internal server port |
| `AUTHENTICATION_API_KEY` | *(Set strong key)* | Global Evolution API key for authentication |
| `AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES` | `true` | Allows instance tokens to be retrieved |
| `CUSTOM_AI_ADMIN_PASSWORD` | *(Set strong password)* | Password for `/dashboard` login |

### Database & Cache
| Variable | Default | Description |
|---|---|---|
| `DATABASE_PROVIDER` | `postgresql` | Database provider (`postgresql`) |
| `DATABASE_CONNECTION_URI` | `postgresql://evolution:password@evolution-postgres:5432/evolution?schema=public` | Connection string |
| `DATABASE_CONNECTION_CLIENT_NAME` | `evolution` | Client identifier |
| `CACHE_REDIS_ENABLED` | `true` | Enable Redis for session & message caching |
| `CACHE_REDIS_URI` | `redis://evolution-redis:6379` | Redis connection URL |
| `CACHE_REDIS_SAVE_INSTANCES` | `true` | Persist instances in Redis |

### Custom AI Chatbot & RAG Defaults
| Variable | Default | Description |
|---|---|---|
| `CUSTOM_AI_ENABLED` | `true` | Master switch for the AI chatbot service |
| `CUSTOM_AI_PROVIDER` | `openai` | Provider: `openai`, `openrouter`, `groq`, `ollama`, or `custom` |
| `CUSTOM_AI_API_KEY` | `sk-...` | API Key for LLM (OpenAI, OpenRouter, Groq, etc.) |
| `CUSTOM_AI_API_URL` | `https://api.openai.com/v1` | Base API endpoint (change for Groq/Ollama/OpenRouter) |
| `CUSTOM_AI_MODEL` | `gpt-4o-mini` | Chat model name (e.g. `gpt-4o-mini`, `claude-3-5-sonnet`, `llama-3.3-70b-versatile`) |
| `CUSTOM_AI_EMBEDDING_PROVIDER` | `openai` | Embedding provider: `openai`, `custom`, or `none` |
| `CUSTOM_AI_EMBEDDING_API_KEY` | *(defaults to LLM key)* | API Key for embeddings |
| `CUSTOM_AI_EMBEDDING_API_URL` | `https://api.openai.com/v1` | Embedding API endpoint |
| `CUSTOM_AI_EMBEDDING_MODEL` | `text-embedding-3-small` | Model name for vector embeddings |
| `CUSTOM_AI_BUSINESS_NAME` | `My Company` | Business name included in RAG system instructions |
| `CUSTOM_AI_SYSTEM_PROMPT` | *(Optional)* | Custom base prompt instructions |

---

## 5. Administrator Walkthrough

### Step 1: Open the Dashboard
Navigate to `https://whatsapp.yourdomain.com/dashboard` (or `http://localhost:8080/dashboard` locally).
- Enter your `CUSTOM_AI_ADMIN_PASSWORD` or `AUTHENTICATION_API_KEY`.
- Click **Unlock Dashboard**.

### Step 2: Connect WhatsApp via QR Code
1. If no instance exists yet, enter an instance name (e.g. `support`) in the top instance selector and click **Connect**.
2. Click **Connect WhatsApp (QR Code)**.
3. Open WhatsApp on your phone:
   - Go to **Linked Devices** -> **Link a Device**.
   - Scan the QR code displayed on the dashboard.
4. The status badge will change from `Connecting` to `🟢 Connected (open)`.

### Step 3: Configure Your AI Assistant
Click on the **AI Assistant** tab:
1. **Assistant & Business Identity**: Set Assistant Name, Business Name, and Company Description.
2. **Business Hours**: Specify working hours (e.g., `Mon-Fri: 9:00 AM - 6:00 PM EST`).
3. **AI Provider & Model**:
   - Provider: Choose OpenAI, OpenRouter, Groq, or Custom.
   - Model: Select or enter any model (e.g., `gpt-4o-mini`, `gpt-4o`, `deepseek-chat`).
   - Temperature: Adjust between 0.0 (strict) and 1.0 (creative). Recommended: `0.3` for customer support.
4. **Behavioral Controls**:
   - **Enable AI Replies**: Turn automatic replies ON or OFF.
   - **Fallback Response**: Message sent when no knowledge matches (e.g., *"I'm sorry, I don't have information on that. Let me connect you with a team member."*).
   - **Human Takeover Keywords**: Comma-separated list (e.g. `human, agent, representative, operator, cancel`).
5. Click **Save AI Settings**.

### Step 4: Build Your Knowledge Base
Click on the **Knowledge Base** tab:
1. **Document Upload**:
   - Drag & drop or select `.pdf`, `.docx`, `.md`, or `.txt` files.
   - Click **Upload & Ingest**. The engine automatically splits documents into chunks, generates vector embeddings, and indexes them.
2. **URL Scraper**:
   - Enter your public website or documentation URL (e.g. `https://yourcompany.com/pricing`).
   - Click **Ingest Website**.
3. **Business FAQ & Policy Editor**:
   - Enter Question and Answer (e.g. *"What is your return policy?"* -> *"Items can be returned within 30 days in original packaging"*).
   - Click **Add FAQ**.
4. **Test RAG Retrieval**:
   - In the **Test Knowledge Retrieval** box, enter a customer query (e.g., *"How much is shipping?"*).
   - Click **Test Search** to inspect retrieved chunks and similarity confidence scores.

### Step 5: Conversation Inbox & Human Takeover
Click on the **Inbox** tab:
1. View customer conversations with real-time indicators.
2. Select any contact to view their complete message thread:
   - Customer messages appear on the left in dark slate bubbles.
   - AI bot responses appear on the right with a blue **AI Bot** badge.
   - Human agent responses appear on the right with a green **Agent** badge.
3. **Taking Over from AI**:
   - Click **Pause AI** on the conversation header to silence automated replies.
   - Type a response in the human agent box and press **Send as Human Agent**.
   - Evolution API sends your message directly through the WhatsApp account.
   - When finished, click **Resume AI** to let the bot resume answering.

---

## 6. Verification and Testing

You can run the built-in automated test suite at any time:

```bash
# Run unit and security tests
npx tsx test/customAi.test.ts

# Run TypeScript compilation check
npm run build
```

Expected output:
```text
--- Running Custom AI Platform Test Suite ---
  ✓ Deduplication: acquires in-flight lock and rejects duplicates
  ✓ DocumentParser: parses plaintext and markdown accurately
  ✓ DocumentParser (SSRF Protection): rejects private/loopback/cloud metadata IP addresses
  ✓ RagService: recursive chunking splits long texts properly with overlap
  ✓ RagService: cosine similarity correctly scores vector alignment
  ✓ RagService: fallback deterministic embeddings produce fixed-size normalized vectors

Tests Completed: 6 passed, 0 failed.
```

---

## 7. Troubleshooting & FAQ

### 1. WhatsApp QR Code disconnects or fails to load
- Ensure `evolution_instances` volume is mounted and writable.
- Verify Redis is running and reachable (`redis-cli ping`).
- If Baileys encounters a 401/428 error, click **Delete Instance** on the dashboard and create a fresh one to generate a new pairing QR code.

### 2. AI Bot is not replying to WhatsApp messages
- Check if AI is enabled: In the dashboard, ensure **Enable AI Replies** is checked.
- Check conversation status: If the contact typed a takeover keyword or was paused, the bot will intentionally remain silent. Click **Resume AI** in the Inbox.
- Check AI API Key: Ensure `CUSTOM_AI_API_KEY` is valid and has billing credits.
- Check Group Messages: By default, the bot ignores WhatsApp groups to avoid spam.

### 3. Database migrations fail on Dokploy
- Evolution API handles migrations automatically during startup via `Docker/scripts/deploy_database.sh`.
- If you are running against an existing PostgreSQL instance, verify the migration history table:
  ```bash
  npm run db:deploy
  ```
- Ensure PostgreSQL user has `CREATE TABLE`, `CREATE INDEX`, and schema alteration permissions.

### 4. Vector search performance
- The system automatically uses native cosine similarity. For larger datasets (>10,000 document chunks), enable `pgvector` by installing the extension:
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  ```
- The code handles both `pgvector` accelerated search and portable JSON fallback automatically.

---

## 8. Backup and Maintenance

- **Database Backup**: Regular PostgreSQL dumps:
  ```bash
  docker exec -t evolution_postgres pg_dump -U evolution -d evolution > backup_$(date +%Y%m%d).sql
  ```
- **Session Tokens**: Back up the `evolution_instances` persistent volume to preserve WhatsApp sessions without re-scanning QR codes.
- **Uploaded Knowledge Files**: Back up the `evolution_uploads` volume.
