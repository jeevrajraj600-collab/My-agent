import type { ChatMessage } from '@freellmapi/shared/types.js';

// OpenAI-spec message content can be one of:
//   - string                        (plain text)
//   - null                          (assistant with tool_calls only)
//   - Array<ContentBlock>           (multimodal envelope — text and/or image_url)
export type ContentTextBlock = { type: 'text'; text: string };
export type ContentImageBlock = {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
};
export type ContentBlock = ContentTextBlock | ContentImageBlock | { type: string; [key: string]: unknown };

export function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : (b as ContentTextBlock)?.type === 'text' ? (b as ContentTextBlock).text : ''))
      .join('');
  }
  return '';
}

/** Extract all image_url blocks from a message content array. */
export function extractImageBlocks(content: unknown): ContentImageBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is ContentImageBlock =>
      b !== null &&
      typeof b === 'object' &&
      (b as ContentBlock).type === 'image_url' &&
      typeof (b as ContentImageBlock).image_url?.url === 'string',
  );
}

/** Returns true if any message in the array contains image content. */
export function hasImageContent(messages: ChatMessage[]): boolean {
  return messages.some((m) => extractImageBlocks(m.content).length > 0);
}

export function flattenMessageContent(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    ...m,
    content: contentToString(m.content),
  }));
}
