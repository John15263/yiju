import { check, fields, oneOf, text } from './validation.mjs';

export const outlineKeys = ['core_logic', 'core_structure', 'supporting_logic', 'supporting_structure', 'uncertainties'];
export function validateOutline(value) {
  fields(value, ['summary', ...outlineKeys], ['summary', ...outlineKeys]); text(value.summary, 2000);
  for (const key of outlineKeys) {
    check(Array.isArray(value[key]) && value[key].length <= 12, 'Invalid outline');
    value[key].forEach(item => text(item, 1000));
  }
  check(value.core_logic.length && value.core_structure.length, 'Supply the core meaning and structure');
  return structuredClone(value);
}
export function unitDetails(value, source, focus = '') {
  oneOf(value.role, ['core', 'support', 'mixed']); text(value.purpose, 300); text(value.connection, 600, true);
  check(Array.isArray(value.source_quotes) && value.source_quotes.length >= 1 && value.source_quotes.length <= 4, 'Supply source evidence');
  value.source_quotes.forEach(quote => {
    text(quote, 1000);
    check(source.includes(quote) || focus.includes(quote), 'Source quote must be an exact excerpt');
  });
  return { role: value.role, purpose: value.purpose, connection: value.connection, source_quotes: [...value.source_quotes] };
}
