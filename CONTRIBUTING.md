# Contributing to VibeBridge

Thank you for your interest in contributing to VibeBridge! This document provides guidelines and workflows for developing and testing the project.

---

## Architecture Overview

VibeBridge is a monorepo organized into workspaces:

- `packages/shared`: Shared TypeScript types, interfaces, and Zod schemas.
- `packages/security`: Sandbox, canonical path resolver, filesystem tools, terminal execution, and permission gatekeeper.
- `packages/mcp-server`: MCP protocol implementation, Streamable HTTP transport, ngrok tunnel manager, and structured logger.
- `apps/desktop`: React frontend and Tauri desktop shell.
- `tests`: Automated security and integration test suite.

---

## Development Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/assishmoncs/vibebridge.git
   cd vibebridge
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build the packages:**
   ```bash
   npm run build
   ```

4. **Run tests:**
   ```bash
   npm test
   ```

---

## Security Guidelines

When adding or modifying filesystem or terminal features:
1. **Never bypass `sandbox.resolveSafePath()`**: All paths from MCP requests MUST be validated using the sandbox.
2. **Never execute shell commands outside the workspace root**: Always pass `cwd: sandbox.getCanonicalPath()`.
3. **Always enforce exact string matches in `edit_file`**: Never perform destructive blind file overwrites.
4. **Never log secrets or auth tokens**: Ensure all logs pass through `StructuredActivityLogger` which redacts authorization headers, tokens, and credentials.
5. **Always add security test cases**: If adding a tool or parameter, write corresponding tests in `tests/`.

---

## Running the Desktop App

To test UI changes:
```bash
npm run dev:desktop
```
Navigate to `http://localhost:1420` in your browser.

To run with Tauri desktop window:
```bash
npm run tauri dev
```

---

## Pull Request Checklist

Before submitting a Pull Request:
- [ ] Code follows strict TypeScript standards without `any` workarounds where types can be specified.
- [ ] All unit and integration tests pass via `npm test`.
- [ ] New features include corresponding test cases.
- [ ] Documentation or README has been updated if tool schemas or configurations changed.
