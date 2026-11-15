import { z } from 'zod';

export const credentials = z.object({
  username: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[\p{L}\p{N}_.@-]+$/u),
  password: z.string().min(12).max(256),
});
