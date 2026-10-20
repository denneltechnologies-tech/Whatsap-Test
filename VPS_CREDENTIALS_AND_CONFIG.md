# Whatsap Test - VPS & Deployment Credentials Reference

This document stores the verified VPS credentials, GitHub repository details, Dokploy settings, and webhook configurations for the **Whatsap Test** project.

---

## 1. VPS Credentials
- **Provider / Host**: Dokploy on VPS
- **IP Address**: `69.62.106.189`
- **SSH User**: `root`
- **SSH Password**: `Kissinger2026@`
- **Dokploy Web UI**: `https://admin.growthshperegh.cloud` (or `http://69.62.106.189:3000`)

---

## 2. GitHub Repository & Auto-Deploy Webhook
- **Repository**: [https://github.com/denneltechnologies-tech/Whatsap-Test](https://github.com/denneltechnologies-tech/Whatsap-Test)
- **Account / Owner**: `denneltechnologies-tech`
- **Default Branch**: `main`
- **Auto-Deploy Webhook**:
  - **Webhook URL**: `https://admin.growthshperegh.cloud/api/deploy/compose/wt_deploy_acad3d7503256fd2f69113ba3fa04373`
  - **Direct IP Webhook**: `http://69.62.106.189:3000/api/deploy/compose/wt_deploy_acad3d7503256fd2f69113ba3fa04373`
  - **Events**: `push`
  - **Status**: Active (GitHub Hook ID: `701006390`)
  - **Behavior**: Whenever code is pushed to `main`, GitHub automatically pings this webhook and Dokploy rebuilds and deploys the stack.

---

## 3. Dokploy Project & Service Configuration
- **Project Name**: `Whatsap Test`
- **Project ID**: `BT6ICRdrHWUdFCp5FixLP`
- **Environment**: `production` (`75_4Gh-x0sMoVBigJLNoX`)
- **Compose Service ID**: `c_whatsap_test_compose_01`
- **Compose App Name**: `whatsap-test-evolution`
- **Compose Path**: `./docker-compose.yaml`
- **Traefik Public Domain**: `https://whatsap-69-62-106-189.sslip.io`
- **AI Dashboard URL**: `https://whatsap-69-62-106-189.sslip.io/dashboard`
- **Dashboard Password**: `Kissinger2026@`
- **Evolution API Key**: `dennel_tech_evolution_api_key_2026`

---

## 4. Container Architecture on VPS
- **API Service**: `evolution_api` (Evolution API + Custom AI Chatbot + RAG Knowledge Base Engine) on port `8080`.
- **Database Service**: `evolution-postgres` (`pgvector/pgvector:pg15`) on port `5432`.
- **Cache Service**: `evolution_redis` (`redis:alpine`) on port `6379`.
- **Network**: `evolution-net` and `dokploy-network`.
- **Proxy**: Dokploy Traefik with automatic Let's Encrypt SSL.
