// Parser minimalista para el DSL de query de Zendesk Support.
// Soporta:
//   - filtros `key:value` (con o sin comillas: email:"foo bar" type:user)
//   - términos libres (cualquier token suelto)
// Retorna: { filters: { key: [val, ...] }, freeTerms: [ ... ] }
//
// Ejemplos:
//   'type:user email:foo@bar.com'  →
//     { filters: { type: ['user'], email: ['foo@bar.com'] }, freeTerms: [] }
//   'foo bar name:"John Doe"'      →
//     { filters: { name: ['John Doe'] }, freeTerms: ['foo', 'bar'] }

const TOKEN_REGEX = /(\w+):("([^"]*)"|\S+)|"([^"]*)"|\S+/g;

export function parseZendeskQuery(query) {
  const result = { filters: {}, freeTerms: [] };
  if (!query || typeof query !== "string") return result;

  let match;
  while ((match = TOKEN_REGEX.exec(query)) !== null) {
    if (match[1] !== undefined) {
      const key = match[1].toLowerCase();
      const value = match[3] !== undefined ? match[3] : match[2];
      (result.filters[key] ??= []).push(value);
    } else if (match[4] !== undefined) {
      result.freeTerms.push(match[4]);
    } else {
      result.freeTerms.push(match[0]);
    }
  }
  return result;
}
