import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { safeStorage } from "electron";
import type { TokenStore } from "./account";

// Credentials stay in main; each backend origin gets a separate encrypted session.
export class AccountStorage implements TokenStore {
  private value: string | null | undefined;
  private readonly file: string;
  constructor(directory: string, origin: string) {
    this.file = path.join(
      directory,
      `account-${createHash("sha256").update(origin).digest("hex")}.bin`,
    );
  }
  private secure(): boolean {
    return (
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" ||
        safeStorage.getSelectedStorageBackend() !== "basic_text")
    );
  }
  async read(): Promise<string | null> {
    if (this.value !== undefined) return this.value;
    if (!this.secure()) {
      this.value = null;
      return null;
    }
    try {
      const token = safeStorage.decryptString(await fs.readFile(this.file));
      this.value = /^[a-f0-9]{64}$/.test(token) ? token : null;
    } catch {
      this.value = null;
    }
    return this.value;
  }
  async write(token: string | null): Promise<void> {
    this.value = token;
    // Without an OS key store keep the session in memory; never persist plaintext.
    if (!token || !this.secure()) {
      await fs.rm(this.file, { force: true });
      return;
    }
    const temporary = `${this.file}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(temporary, safeStorage.encryptString(token), {
        mode: 0o600,
      });
      await fs.rename(temporary, this.file);
    } catch {
      // A disk failure must not restore an older session on next launch.
      await fs.rm(this.file, { force: true });
      await fs.rm(temporary, { force: true });
    }
  }
}
