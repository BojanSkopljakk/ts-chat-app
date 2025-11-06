import { z } from "zod";

export const ClientMessageSchema = z.object({
  type: z.literal("message"),
  room: z.string().min(1),
  text: z.string().min(1).max(2000),
  username: z.string().min(1).max(40),
});

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ServerEvent =
  | { type: "history"; room: string; messages: ChatMessage[] }
  | { type: "broadcast"; message: ChatMessage }
  | { type: "system"; text: string; room?: string };

export type ChatMessage = {
  id: string;
  room: string;
  text: string;
  username: string;
  ts: number;
};
