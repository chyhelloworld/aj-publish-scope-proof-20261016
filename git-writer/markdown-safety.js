// Compare Markdown meaning before allowing whole-document rich-text serialization.
// Whitespace/raw spelling may normalize; unsupported content must stay in source mode.
function semantic(value) {
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value.filter(item => item?.type !== 'space').map(semantic)) {
      const previous = result.at(-1);
      if (item?.type === 'text' && !item.tokens && previous?.type === 'text' && !previous.tokens)
        previous.text += item.text;
      else result.push(item);
    }
    return result;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['raw', 'loose', 'escaped'].includes(key) && !(key === 'text' && value.tokens))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, key === 'type' && item === 'escape' ? 'text' : semantic(item)]));
}
export function preservesMarkdown(manager, source, serialized) {
  try {
    const describe = text => {
      const tokens = manager.instance.lexer(text);
      return JSON.stringify({ tokens: semantic(tokens), definitions: semantic(tokens.links || {}) });
    };
    return describe(source) === describe(serialized ?? manager.serialize(manager.parse(source)));
  } catch {
    return false;
  }
}
