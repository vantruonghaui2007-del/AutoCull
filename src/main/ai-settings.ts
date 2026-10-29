import { app, safeStorage } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AiSettingsView } from '../shared/contracts';

interface Stored {
  endpoint?: string;
  tokenEnc?: string;
  consentAt?: string;
}

/**
 * Pilot AI settings. The token is encrypted with the OS keychain (safeStorage) when available;
 * otherwise it is kept in memory for this session only and never written in clear. The renderer
 * only ever receives `AiSettingsView` (no token).
 */
export class AiSettings {
  private stored: Stored = {};
  private memoryToken: string | null = null;
  private loaded = false;

  private get file(): string {
    return path.join(app.getPath('userData'), 'ai.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.stored = JSON.parse(await readFile(this.file, 'utf8')) as Stored;
    } catch {
      this.stored = {};
    }
    if (this.stored.tokenEnc && safeStorage.isEncryptionAvailable()) {
      try {
        this.memoryToken = safeStorage.decryptString(Buffer.from(this.stored.tokenEnc, 'base64'));
      } catch {
        this.memoryToken = null;
      }
    }
  }

  private async persist(): Promise<void> {
    await writeFile(this.file, JSON.stringify(this.stored, null, 2));
  }

  credentials(): { endpoint: string; token: string } | null {
    return this.stored.endpoint && this.memoryToken ? { endpoint: this.stored.endpoint, token: this.memoryToken } : null;
  }

  view(): AiSettingsView {
    return {
      endpoint: this.stored.endpoint ?? null,
      hasToken: this.memoryToken !== null,
      tokenPersisted: !!this.stored.tokenEnc && this.memoryToken !== null,
      consentAt: this.stored.consentAt ?? null,
    };
  }

  /** `token` null keeps the current token; empty string removes it. */
  async save(endpoint: string, token: string | null): Promise<void> {
    await this.load();
    this.stored.endpoint = endpoint;
    if (token === '') {
      this.memoryToken = null;
      delete this.stored.tokenEnc;
    } else if (token !== null) {
      this.memoryToken = token;
      if (safeStorage.isEncryptionAvailable()) this.stored.tokenEnc = safeStorage.encryptString(token).toString('base64');
      else delete this.stored.tokenEnc;
    }
    await this.persist();
  }

  async setConsent(accepted: boolean): Promise<void> {
    await this.load();
    if (accepted) this.stored.consentAt = new Date().toISOString();
    else delete this.stored.consentAt;
    await this.persist();
  }
}
