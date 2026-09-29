import { z } from 'zod';

export const SourceSchema = z.object({
  id: z.string().regex(/^SRC-\d{3}$/),
  title: z.string().min(1),
  section: z.string().min(1),
  path: z.string().startsWith('/sources/'),
  content: z.string().min(1),
});

export const FaqSchema = z.object({
  id: z.string().regex(/^FAQ-\d{3}$/),
  question: z.string().min(1),
  answer: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
  sourceIds: z.array(z.string().regex(/^SRC-\d{3}$/)).min(1),
});

export const SourcesSchema = z.array(SourceSchema);
export const FaqsSchema = z.array(FaqSchema);

export type KnowledgeSource = z.infer<typeof SourceSchema>;
export type Faq = z.infer<typeof FaqSchema>;

export interface KnowledgeBase {
  faqs: Faq[];
  sources: KnowledgeSource[];
}
