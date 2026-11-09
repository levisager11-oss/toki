import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_DEADLINE_MS, UPLOAD_GAP_MS, readRecord, SaveSync, type Cloud, type KeyValue, type SaveData } from "../src/lib/saves";

const GAME = "g1";
const USER = "u1";

/** The account, with the same rule as put_game_save in supabase/schema.sql. */
class FakeCloud implements Cloud {
  save: SaveData | null = null;
  conflicts = new Map<string, SaveData>();
  earlier: SaveData[] = [];
  readDelay = 10;
  readFails = false;
  putFails = false;
  puts = 0;
  read() {
    return new Promise<SaveData | null>((resolve, reject) =>
      setTimeout(() => (this.readFails ? reject(new Error("offline")) : resolve(this.save && { ...this.save })), this.readDelay),
    );
  }
  async put(_g: string, save: SaveData, bases: number[], device: string) {
    this.puts++;
    if (this.putFails) throw new Error("offline");
    if (!this.save || this.save.t === save.t) {
      this.save = save;
      return { ok: true, current: null };
    }
    if (bases.includes(this.save.t)) {
      this.earlier.push(this.save);
      this.save = save;
      return { ok: true, current: null };
    }
    this.conflicts.set(device, save);
    return { ok: false, current: this.save };
  }
}

class MemoryKV implements KeyValue {
  m = new Map<string, string>();
  get = (k: string) => this.m.get(k) ?? null;
  set = (k: string, v: string) => void this.m.set(k, v);
}

/** Behaves like public/toki-save.js inside a game: localStorage plus the "__toki_t" mark. */
class FakeGame {
  storage: Record<string, string> = {};
  mark = 0;
  answered = false;
  ready = false;
  reloads = 0;
  /** The game saves its state on its own while it reloads (autosave timer, saving on close). */
  savesOnClose = false;
  /** Script v2: blocks those saves while Toki's save is put back. */
  v2 = false;
  /** What the game read from storage when it started. */
  private memory: Record<string, string> = {};
  private fallback?: ReturnType<typeof setTimeout>;
  constructor(private toki: () => SaveSync, private freshSave: Record<string, string> = { level: "1" }) {}

  start() {
    this.answered = false;
    this.ready = false;
    clearTimeout(this.fallback);
    // A fresh game writes its starting save right away (not sent: not ready yet).
    if (Object.keys(this.storage).length === 0) this.storage = { ...this.freshSave };
    this.memory = { ...this.storage };
    this.fallback = setTimeout(() => (this.ready = true), 10_000);
    this.toki().hello();
  }
  onSave(save: SaveData | null) {
    if (this.answered) return;
    this.answered = true;
    if (save && save.keys && save.t > this.mark) {
      this.storage = { ...save.keys };
      this.mark = save.t;
      if (this.savesOnClose && !this.v2) this.storage = { ...this.memory };
      this.reloads++;
      this.start();
      return;
    }
    this.ready = true;
    if (Object.keys(this.storage).length && (!save || this.mark > save.t)) this.flush();
  }
  play(keys: Record<string, string>) {
    this.storage = { ...this.storage, ...keys };
    if (this.ready) this.flush();
  }
  flush() {
    const t = Date.now();
    this.mark = t;
    this.toki().store({ keys: { ...this.storage }, t });
  }
  /** iPhone: storage of games inside other sites is gone after the app closes. */
  wipe() {
    this.storage = {};
    this.mark = 0;
  }
}

/** One browser: Toki's storage, the game's storage, and the game page. */
class Device {
  kv = new MemoryKV();
  game: FakeGame;
  sync!: SaveSync;
  conflict = false;
  lost = false;
  constructor(public name: string, public cloud: FakeCloud, fresh?: Record<string, string>) {
    this.game = new FakeGame(() => this.sync, fresh);
  }
  open(userId: string | null = USER) {
    this.sync?.stop();
    this.sync = new SaveSync({
      gameId: GAME,
      userId: userId ?? undefined,
      cloud: this.cloud,
      kv: this.kv,
      device: this.name,
      answer: (s) => setTimeout(() => this.game.onSave(s), 0),
      onConflict: (c) => (this.conflict = c),
      onLost: (l) => (this.lost = l),
    });
    this.game.start();
  }
  close() {
    this.sync.flush();
    this.sync.stop();
  }
}

const settle = (ms = 100) => vi.advanceTimersByTimeAsync(ms);
/** Long enough for the next upload from a page that uploaded a moment ago. */
const nextUpload = () => settle(UPLOAD_GAP_MS + 1000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("SaveSync", () => {
  it("a fresh login on device B gets A's progress, and A keeps it", async () => {
    const cloud = new FakeCloud();
    const a = new Device("A", cloud);
    a.open();
    await settle();
    a.game.play({ level: "7" });
    await settle(3000);
    expect(cloud.save?.keys.level).toBe("7");

    const b = new Device("B", cloud);
    b.open();
    await settle(3000);
    expect(b.game.storage.level).toBe("7");
    expect(cloud.save?.keys.level).toBe("7");

    a.close();
    a.open();
    await settle(3000);
    expect(a.game.storage.level).toBe("7");
    expect(cloud.save?.keys.level).toBe("7");
  });

  it("progress made on B then reaches A", async () => {
    const cloud = new FakeCloud();
    const a = new Device("A", cloud);
    a.open();
    await settle();
    a.game.play({ level: "3" });
    await settle(3000);
    a.close();
    const b = new Device("B", cloud);
    b.open();
    await settle(3000);
    b.game.play({ level: "4" });
    await settle(3000);
    b.close();
    a.open();
    await settle(3000);
    expect(a.game.storage.level).toBe("4");
    expect(cloud.save?.keys.level).toBe("4");
  });

  it("never answers 'nothing' while the account save is loading (slow network)", async () => {
    const cloud = new FakeCloud();
    cloud.save = { keys: { level: "9" }, t: Date.now() - 60_000 };
    cloud.readDelay = 8000; // slower than Toki's own deadline, faster than the game's 10 s
    const b = new Device("B", cloud);
    const answers: (SaveData | null)[] = [];
    b.open();
    const orig = b.game.onSave.bind(b.game);
    b.game.onSave = (s) => (answers.push(s), orig(s));
    await settle(ANSWER_DEADLINE_MS + 500);
    expect(answers).toEqual([]); // no copy on this device: still waiting
    await settle(3000);
    expect(answers[0]?.keys.level).toBe("9");
    expect(b.game.storage.level).toBe("9");
    expect(cloud.save?.keys.level).toBe("9");
  });

  it("an account save that arrives after the game gave up waiting still wins", async () => {
    const cloud = new FakeCloud();
    cloud.save = { keys: { level: "9" }, t: Date.now() - 60_000 };
    cloud.readDelay = 15_000;
    const b = new Device("B", cloud);
    b.open();
    await settle(11_000); // the game's 10 s fallback: it plays on its fresh save
    b.game.play({ level: "1", coins: "2" });
    await settle(3000);
    expect(cloud.save?.keys.level).toBe("9"); // the fresh save didn't go up over it
    await settle(5000);
    expect(b.game.storage.level).toBe("9");
    expect(cloud.save?.keys.level).toBe("9");
  });

  it("never overwrites the account while it can't be read", async () => {
    const cloud = new FakeCloud();
    cloud.save = { keys: { level: "9" }, t: Date.now() - 60_000 };
    cloud.readFails = true;
    const b = new Device("B", cloud);
    b.open();
    await settle(12_000);
    b.game.play({ level: "1" });
    await settle(10_000);
    expect(cloud.puts).toBe(0);
    expect(cloud.save?.keys.level).toBe("9");
    cloud.readFails = false;
    await settle(10_000);
    expect(cloud.save?.keys.level).toBe("9");
    expect(b.game.storage.level).toBe("9");
  });

  it("a stale device keeps the account copy and leaves a conflict copy", async () => {
    const cloud = new FakeCloud();
    const a = new Device("A", cloud);
    a.open();
    await settle();
    a.game.play({ level: "2" });
    await settle(3000);
    const b = new Device("B", cloud);
    b.open();
    await settle(3000);
    b.game.play({ level: "5" });
    await settle(3000);
    // A is still open on the old version and saves.
    a.game.play({ coins: "1" });
    await nextUpload();
    expect(cloud.save?.keys.level).toBe("5");
    expect(cloud.conflicts.get("A")?.keys).toEqual({ level: "2", coins: "1" });
    expect(a.conflict).toBe(true);
    // "Continue from the newer progress": the game starts again and gets B's progress.
    a.game.start();
    await settle(100);
    expect(a.game.storage.level).toBe("5");
    expect(a.conflict).toBe(false);
  });

  it("logging out uploads nothing, and play after logout doesn't reach the account", async () => {
    const cloud = new FakeCloud();
    const a = new Device("A", cloud);
    a.open();
    await settle();
    a.game.play({ level: "6" });
    await settle(3000);
    a.game.play({ level: "7" }); // not sent yet
    const puts = cloud.puts;
    a.sync.stop(); // logout (stopAccountSaves)
    a.open(null); // the game starts again for a visitor
    await settle(3000);
    expect(cloud.puts).toBe(puts);
    a.game.wipe(); // e.g. a fresh start while logged out
    a.game.start();
    await settle(100);
    a.game.play({ level: "1" });
    await settle(3000);
    expect(cloud.save?.keys.level).toBe("6");

    // Log in again: the account copy (with the unsent level 7 from this device) comes back.
    a.open(USER);
    await settle(3000);
    expect(a.game.storage.level).toBe("7");
    expect(cloud.save?.keys.level).toBe("7");
  });

  it("another account's progress on the same device doesn't go into this account", async () => {
    const cloud = new FakeCloud();
    const a = new Device("A", cloud);
    a.open(USER);
    await settle();
    a.game.play({ level: "8" });
    await settle(3000);
    a.sync.stop();
    a.open(null);
    await settle();
    a.game.wipe();
    a.game.start();
    await settle();
    a.game.play({ level: "1" }); // a visitor plays later, the game's save looks newer
    await settle(100);
    a.open(USER);
    await settle(3000);
    expect(a.game.storage.level).toBe("8");
    expect(cloud.save?.keys.level).toBe("8");
  });

  it("an iPhone that lost the game's storage gets the save back", async () => {
    const cloud = new FakeCloud();
    const a = new Device("A", cloud);
    a.open();
    await settle();
    a.game.play({ level: "4" });
    await settle(3000);
    a.close();
    a.game.wipe();
    a.open();
    await settle(3000);
    expect(a.game.storage.level).toBe("4");
    expect(cloud.save?.keys.level).toBe("4");
  });

  const progress = { level: "7", coins: "12345", items: "sword,shield,bow,map" };

  it("a game that saves its fresh state while putting the save back doesn't overwrite the account", async () => {
    const cloud = new FakeCloud();
    const a = new Device("A", cloud);
    a.open();
    await settle();
    a.game.play(progress);
    await settle(3000);
    a.close();
    a.game.wipe();
    a.game.savesOnClose = true; // old script in the game
    a.open();
    await settle(3000);
    expect(a.game.storage).toEqual({ level: "1" }); // the game started fresh
    a.game.play({ level: "1" }); // its autosave
    await settle(3000);
    a.game.play({ level: "2" });
    await nextUpload();
    expect(cloud.save?.keys).toEqual(progress);
    expect(a.lost).toBe(true);
    expect(cloud.conflicts.get("A")?.keys.level).toBe("2"); // kept as a backup

    // Once the game has the new script, "Load my progress" works.
    a.game.v2 = true;
    a.game.start();
    await settle(3000);
    expect(a.game.storage).toEqual(progress);
    expect(a.lost).toBe(false);
    a.game.play({ level: "8" });
    await nextUpload();
    expect(cloud.save?.keys.level).toBe("8");
  });

  it("with the new script the save is put back even when the game saves while reloading", async () => {
    const cloud = new FakeCloud();
    const a = new Device("A", cloud);
    a.open();
    await settle();
    a.game.play(progress);
    await settle(3000);
    a.close();
    a.game.wipe();
    a.game.savesOnClose = true;
    a.game.v2 = true;
    a.open();
    await settle(3000);
    expect(a.game.storage).toEqual(progress);
    a.game.play({ level: "8" });
    await settle(3000);
    expect(cloud.save?.keys).toEqual({ ...progress, level: "8" });
    expect(a.lost).toBe(false);
  });

  it("visitors keep their progress when the game starts fresh while putting it back", async () => {
    const cloud = new FakeCloud();
    const a = new Device("A", cloud);
    a.open(null);
    await settle();
    a.game.play(progress);
    await settle(100);
    a.game.wipe();
    a.game.savesOnClose = true;
    a.open(null);
    await settle(100);
    a.game.play({ level: "1" });
    await settle(100);
    expect(a.lost).toBe(true);
    expect(readRecord(a.kv, "anon", GAME)?.save.keys).toEqual(progress);
    a.game.v2 = true;
    a.open(null);
    await settle(100);
    expect(a.game.storage).toEqual(progress);
  });

  it("a deliberate new game later on still replaces the save", async () => {
    const cloud = new FakeCloud();
    const a = new Device("A", cloud);
    a.open();
    await settle();
    a.game.play(progress);
    await settle(3000);
    await settle(60_000);
    a.game.storage = {};
    a.game.play({ level: "1" });
    await settle(3000);
    expect(cloud.save?.keys).toEqual({ level: "1" });
    expect(a.lost).toBe(false);
  });

  it("a lost answer to an upload doesn't cause a false conflict", async () => {
    const cloud = new FakeCloud();
    const a = new Device("A", cloud);
    a.open();
    await settle();
    a.game.play({ level: "2" });
    await settle(3000);
    const realPut = cloud.put.bind(cloud);
    cloud.put = async (...args) => {
      await realPut(...args); // arrives, but the answer is lost
      throw new Error("timeout");
    };
    a.game.play({ level: "3" });
    await nextUpload();
    cloud.put = realPut;
    a.game.play({ level: "4" });
    await nextUpload();
    expect(cloud.save?.keys.level).toBe("4");
    expect(cloud.conflicts.size).toBe(0);
    expect(a.conflict).toBe(false);
  });

  it("a game that saves every second uploads at most every 30 seconds, and at once on closing", async () => {
    const cloud = new FakeCloud();
    const a = new Device("A", cloud);
    a.open();
    await settle();
    for (let i = 1; i <= 60; i++) {
      a.game.play({ level: String(i) });
      await settle(1000);
    }
    expect(cloud.puts).toBeLessThanOrEqual(3);
    a.game.play({ level: "61" });
    a.close();
    await settle();
    expect(cloud.save?.keys.level).toBe("61");
  });

  it("a save that didn't change isn't uploaded again", async () => {
    const cloud = new FakeCloud();
    const a = new Device("A", cloud);
    a.open();
    await settle();
    a.game.play({ level: "2" });
    await settle(3000);
    const puts = cloud.puts;
    a.game.play({ level: "2" }); // the same state, saved again
    await nextUpload();
    a.close();
    await settle();
    expect(cloud.puts).toBe(puts);
    // A real change still goes up.
    a.open();
    await settle(3000);
    a.game.play({ level: "3" });
    await settle(3000);
    expect(cloud.save?.keys.level).toBe("3");
  });

  it("first login keeps progress made before logging in", async () => {
    const cloud = new FakeCloud();
    const a = new Device("A", cloud);
    a.open(null);
    await settle();
    a.game.play({ level: "3" });
    await settle(100);
    a.open(USER);
    await settle(3000);
    expect(cloud.save?.keys.level).toBe("3");
    expect(a.game.storage.level).toBe("3");
  });

  it("visitors keep saves on the device only", async () => {
    const cloud = new FakeCloud();
    const a = new Device("A", cloud);
    a.open(null);
    await settle();
    a.game.play({ level: "2" });
    await settle(3000);
    expect(cloud.puts).toBe(0);
    a.game.wipe();
    a.open(null);
    await settle();
    expect(a.game.storage.level).toBe("2");
  });

  it("reads saves stored by the previous version of Toki", () => {
    const kv = new MemoryKV();
    kv.set(`toki.save.${USER}.${GAME}`, JSON.stringify({ keys: { a: "1" }, t: 5 }));
    expect(readRecord(kv, USER, GAME)).toEqual({ save: { keys: { a: "1" }, t: 5 }, bases: [5], dirty: true });
  });
});
