import { Database } from "bun:sqlite";
import { sqliteSettingsStorage, type SettingsStorage } from "@kraka/client-runtime";
export class SqliteSettingsStorage implements SettingsStorage {
  private db: Database;
  readonly update: SettingsStorage["update"];
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.update = sqliteSettingsStorage(this.db).update;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close() {
    this.db.close(true);
  }
}
