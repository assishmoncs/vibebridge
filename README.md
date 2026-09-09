# VibeBridge

<div align="center">

**A secure, local Model Context Protocol (MCP) bridge connecting Gemini Spark to your local coding workspace, filesystem, and development environment.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-2024--11--05-green.svg)](https://modelcontextprotocol.io/)
[![Tauri](https://img.shields.io/badge/Tauri-1.5-orange.svg)](https://tauri.app/)

</div>

---

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Why Model Context Protocol (MCP)?](#why-model-context-protocol-mcp)
4. [How Gemini Spark Connects](#how-gemini-spark-connects)
5. [Key Features](#key-features)
6. [Security & Sandboxing Model](#security--sandboxing-model)
7. [Available MCP Tools](#available-mcp-tools)
8. [Installation & Setup](#installation--setup)
9. [Configuring Ngrok & Public Tunnel](#configuring-ngrok--public-tunnel)
10. [Running the Desktop App & CLI](#running-the-desktop-app--cli)
11. [Testing](#testing)
12. [Current Limitations](#current-limitations)
13. [Roadmap](#roadmap)

---

## Overview

**VibeBridge** is a local desktop application and runtime service that acts as an execution bridge between **Gemini Spark** (Google's AI model/agent) and a developer's local coding workspace.

In this architecture:
- **Gemini Spark is the agent and brain**: It performs the reasoning, reads project files, writes code, designs architectures, and decides what commands to execute.
- **VibeBridge is the local hands**: It executes on the user's computer, enforces security boundaries, isolates filesystem operations to the selected project folder, runs shell commands in that directory, and requests user approval for sensitive operations.

> **Note**: VibeBridge is *not* another LLM orchestration layer or autonomous agent. It is purely the local runtime exposing controlled MCP tools to Gemini Spark.

---

## Architecture

VibeBridge is structured into clean, decoupled layers:

```
┌─────────────────────────────────────────────────────────────┐
│                        Gemini Spark                         │
│                    (AI Agent & Planner)                     │
└──────────────────────────────┬──────────────────────────────┘
                               │
               HTTPS / MCP Protocol (Streamable HTTP)
               POST /mcp | GET /mcp (SSE) | DELETE /mcp
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                    Public HTTPS Tunnel                      │
│            (ngrok / custom reverse proxy)                   │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                  VibeBridge Local Runtime                   │
│                                                             │
│  ┌──────────────────────┐        ┌───────────────────────┐  │
│  │   Streamable HTTP    │        │  Permission Manager   │  │
│  │  Transport (/mcp)    │◄──────►│ (Allow/Deny Dialog)   │  │
│  └──────────┬───────────┘        └───────────────────────┘  │
│             │                                               │
│  ┌──────────▼───────────┐        ┌───────────────────────┐  │
│  │      MCP Server      │        │  Activity Logger      │  │
│  │  (Tool Definitions)  │◄──────►│ (Secret Redaction)    │  │
│  └──────────┬───────────┘        └───────────────────────┘  │
│             │                                               │
│  ┌──────────▼────────────────────────────────────────────┐  │
│  │           Security Sandbox & Path Resolver            │  │
│  │   (Canonical path resolution, symlink escape checks)  │  │
│  └──────────┬─────────────────────────────────┬──────────┘  │
│             │                                 │             │
│  ┌──────────▼───────────┐        ┌────────────▼──────────┐  │
│  │   Filesystem Tools   │        │   Terminal Executor   │  │
│  │ (Read, Edit, Create) │        │ (Workspace cwd, Caps) │  │
│  └──────────┬───────────┘        └────────────┬──────────┘  │
└─────────────┼─────────────────────────────────┼─────────────┘
              │                                 │
┌─────────────▼─────────────────────────────────▼─────────────┐
│                  Selected Local Workspace                   │
│          (/Users/name/projects/my-app or C:\Projects)       │
└─────────────────────────────────────────────────────────────┘
```

### Components

- **`apps/desktop`**: Modern React + TypeScript interface embedded in a Tauri desktop shell. Features workspace selection, MCP endpoint copy, connection indicators, real-time activity log feed, and interactive permission dialogs.
- **`packages/security`**: Realpath-based canonical sandbox that strictly confines file operations to the chosen workspace and executes terminal commands with the project root as `cwd`.
- **`packages/mcp-server`**: Streamable HTTP MCP transport (`POST /mcp`, `GET /mcp` SSE streams, `DELETE /mcp` session termination), protocol dispatch, and pluggable tunnel management.
- **`packages/shared`**: Strongly typed schemas, Zod validators, and shared contracts.

---

## Why Model Context Protocol (MCP)?

The [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is the open standard for connecting AI models to external tools, data sources, and execution environments.

Using MCP provides key advantages:
1. **Zero Proprietary Lock-in**: Standard JSON-RPC schemas conform to the official specification.
2. **Streamable HTTP Transport**: Operates over modern HTTP with Server-Sent Events (SSE), making it natively compatible with cloud-hosted models like Gemini Spark communicating over secure public HTTPS tunnels.
3. **Explicit Tool Contracts**: Gemini Spark receives strict JSON schemas for every tool, allowing deterministic tool selection, argument generation, and structured error responses.

---

## How Gemini Spark Connects

1. You launch VibeBridge and select a workspace directory (e.g. `~/projects/my-web-app`).
2. VibeBridge starts the local MCP server on port `3000` and initializes an encrypted HTTPS tunnel via ngrok.
3. VibeBridge generates a public MCP endpoint:
   ```
   https://your-tunnel-subdomain.ngrok-free.app/mcp
   ```
4. In Gemini Spark, you configure or prompt the bridge with this URL.
5. Gemini Spark initializes an MCP session, lists the available workspace tools, and uses them to read code, search references, edit files, and run commands.

---

## Security & Sandboxing Model

Protecting the host system from unauthorized access or path traversal is the central priority of VibeBridge.

### 1. Canonical Workspace Resolution
- Path validation does not rely on simple string prefix checks.
- Paths are resolved to their **canonical realpath** (`fs.realpathSync`) on the host filesystem.
- Symlinks pointing outside the workspace boundary are identified and rejected with a `SecurityError`.
- Null-byte injections and directory traversal sequences (`../../`, `/etc/`, Windows drive jumps) are blocked before reaching any filesystem call.

### 2. Guarded File Editing
- Destructive full-file overwrite is discouraged.
- The primary editing tool `edit_file(path, old_text, new_text)` requires exact matching of `old_text`.
- If `old_text` does not match the actual file content, the operation fails safely without corrupting the file, returning the line count and a contextual diff snippet to Gemini Spark.

### 3. Safe Terminal Execution
- Commands are executed strictly with `cwd` set to the workspace canonical path.
- Hard output caps (256 KB) prevent memory exhaustion or application crashes from massive build logs.
- Configurable execution timeouts (default: 30 seconds) kill stuck or hanging processes automatically.

### 4. Interactive Permission Gatekeeper
VibeBridge separates operations into distinct trust tiers:

| Tier | Tools | Default Policy |
| :--- | :--- | :--- |
| **Read** | `list_files`, `read_file`, `search_files` | Auto-approved (logged) |
| **Write** | `create_file`, `edit_file`, `delete_file`, `move_file` | Requires User Approval |
| **Execute** | `run_command` | Requires User Approval |

Whenever Gemini Spark calls a **Write** or **Execute** tool, VibeBridge pops up an interactive **Permission Dialog** in the UI detailing:
- The exact operation (`CREATE`, `EDIT`, `DELETE`, `MOVE`, `EXECUTE`)
- Target file path or shell command
- Full parameter payload / code diff
- **Allow** / **Deny** controls

---

## Available MCP Tools

VibeBridge exposes 8 tools to Gemini Spark:

### 1. `list_files`
List directory entries within the workspace.
- `path` *(optional)*: Subdirectory relative to workspace root (default: `""`).
- `recursive` *(optional)*: Whether to traverse subdirectories recursively (default: `false`).
- `include_hidden` *(optional)*: Include dotfiles (default: `false`).

### 2. `read_file`
Read UTF-8 text files with optional line pagination.
- `path` *(required)*: Relative path to the file.
- `line_offset` *(optional)*: Starting line index for chunked reading.
- `line_count` *(optional)*: Number of lines to read.

### 3. `search_files`
Search for text or regex across workspace files.
- `query` *(required)*: String to search for.
- `path` *(optional)*: Subfolder to restrict search.
- `file_pattern` *(optional)*: Glob pattern (e.g. `*.ts`, `*.json`).
- `case_sensitive` *(optional)*: Default `false`.

### 4. `create_file`
Create a new file with content. Automatically creates parent directories.
- `path` *(required)*: Relative path for the new file.
- `content` *(required)*: Text content to write.
- `overwrite` *(optional)*: If `false` (default), fails if file already exists.

### 5. `edit_file`
Replace specific text within an existing file.
- `path` *(required)*: Relative path to the file.
- `old_text` *(required)*: Exact string to find and replace.
- `new_text` *(required)*: Replacement string.
- `replace_all` *(optional)*: Replace all matches if `true` (default: `false`).

### 6. `delete_file`
Delete a file or directory.
- `path` *(required)*: Relative path to delete.
- `recursive` *(optional)*: Required if deleting a directory (default: `false`).

### 7. `move_file`
Rename or move a file/directory inside the workspace.
- `source_path` *(required)*: Current relative path.
- `destination_path` *(required)*: Target relative path.
- `overwrite` *(optional)*: Default `false`.

### 8. `run_command`
Execute shell commands in the project directory.
- `command` *(required)*: Shell command string (e.g. `npm test`, `git status`).
- `timeout_ms` *(optional)*: Maximum execution time in ms (default: `30000`).

---

## Installation & Setup

### Prerequisites
- [Node.js](https://nodejs.org/) v18.0.0 or higher
- [npm](https://www.npmjs.com/) v9.0.0 or higher
- [Rust & Cargo](https://rustup.rs/) *(optional, only needed if compiling the native Tauri desktop bundle)*
- [ngrok](https://ngrok.com/) account & auth token *(for public HTTPS tunneling)*

### 1. Clone the Repository
```bash
git clone https://github.com/assishmoncs/vibebridge.git
cd vibebridge
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment
Copy the example environment configuration:
```bash
cp .env.example .env
```
Edit `.env` and set your preferred settings:
```ini
PORT=3000
VIBEBRIDGE_WORKSPACE=/absolute/path/to/your/project
NGROK_AUTHTOKEN=your_ngrok_auth_token_here
PERMISSION_MODE=prompt
```

---

## Configuring Ngrok & Public Tunnel

To allow Gemini Spark to access your local MCP server over the internet:

1. Sign up for a free account at [ngrok.com](https://ngrok.com).
2. Retrieve your Authtoken from the [ngrok Dashboard](https://dashboard.ngrok.com/get-started/your-authtoken).
3. Set your token via environment variable:
   ```bash
   export NGROK_AUTHTOKEN="your_token_here"
   ```
   Or place it in your `.env` file.
4. When VibeBridge starts, it will automatically establish the tunnel and display your public MCP endpoint:
   ```
   https://xyz123.ngrok-free.app/mcp
   ```

---

## Running the Desktop App & CLI

### Option A: Run the Desktop GUI (Vite / Browser Dev)
```bash
npm run dev:desktop
```
Opens the developer UI at `http://localhost:1420` with full sidebar controls, live log streams, and approval modals.

### Option B: Run via Desktop Tauri Shell
```bash
npm run tauri dev
```
Compiles and launches the native native Tauri desktop application.

### Option C: Run Headless CLI / Server
```bash
# Run on the current directory
npm run vibebridge

# Or specify a custom workspace and port
node packages/mcp-server/dist/cli.js --workspace /path/to/project --port 3000
```

---

## Testing

Run the automated test suite covering security sandboxing, path traversal rejection, filesystem operations, exact-match editing, terminal execution, and MCP Streamable HTTP transport:

```bash
npm test
```

All 29+ security and integration tests run with zero external dependencies using Node's built-in test runner.

---

## Current Limitations

- **Single Workspace per Instance**: VibeBridge isolates operations to one workspace root at a time. Multi-root workspaces can be switched via the UI or by running multiple instances on different ports.
- **Binary Files**: `read_file` detects binary files and refuses to read them as UTF-8 text to prevent corruption or context window pollution.
- **Git Staging UX**: Git CLI commands can be run via `run_command("git diff")`, but dedicated visual diff views are planned for v0.2.

---

## Roadmap

- [x] Streamable HTTP MCP transport (`POST`, `GET`, `DELETE` at `/mcp`)
- [x] Canonical path sandbox & symlink escape prevention
- [x] Exact-match safe file editor
- [x] Output-capped terminal command execution
- [x] Interactive Allow/Deny permission dialogs
- [x] Pluggable HTTPS tunnel support (ngrok & direct)
- [x] React + Tauri desktop interface
- [ ] Visual Git diff inspection in Desktop UI
- [ ] Cloudflare Quick Tunnels (`cloudflared`) provider integration
- [ ] Workspace file indexer & symbol search

---

## License

MIT © 2026 [assishmoncs](https://github.com/assishmoncs)
