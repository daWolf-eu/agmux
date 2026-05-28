import { ulid } from "ulid";

export function mintSessionId(): string {
  return Bun.randomUUIDv7();
}

export function mintEventId(): string {
  return ulid();
}
