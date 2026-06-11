import React from "react";
import { Text } from "ink";
import type { SessionRow } from "@agmux/protocol";
import { formatTable } from "./format.ts";

export function SessionTable({ rows, reverse }: { rows: SessionRow[]; reverse: boolean }) {
  return <Text>{formatTable(rows, reverse).join("\n")}</Text>;
}
