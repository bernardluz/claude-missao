// Subconjunto de JSON Schema usado pelo núcleo, sem coerção de tipos.
const TIPOS = new Set(['object', 'array', 'string', 'boolean', 'integer', 'number', 'null'])
const CHAVES = new Set(['type', 'properties', 'required', 'items', 'maxItems', 'minItems', 'enum', 'description', 'additionalProperties'])
function conferir(s) {
  if (!s || typeof s !== 'object' || !TIPOS.has(s.type) || Object.keys(s).some(k => !CHAVES.has(k))) {
    throw new Error('schema não suportado pelo adaptador Codex')
  }
  if (s.type === 'object' && (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties))) throw new Error('schema object sem properties')
  if (s.required && (!Array.isArray(s.required) || s.required.some(k => !(k in (s.properties ?? {}))))) throw new Error('schema required inválido')
}
export function schemaEstrito(s) {
  conferir(s)
  const r = { ...s }
  if (s.type === 'object') {
    r.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k,
      (s.required ?? []).includes(k) ? schemaEstrito(v) : { anyOf: [schemaEstrito(v), { type: 'null' }] },
    ]))
    r.required = Object.keys(s.properties)
    r.additionalProperties = false
  }
  if (s.type === 'array') r.items = schemaEstrito(s.items)
  return r
}
export function normalizarResultado(v, s, caminho = '$') {
  conferir(s)
  const erro = () => { throw new Error(`resposta fora do contrato/schema em ${caminho}`) }
  const tipo = s.type
  if (tipo === 'null') { if (v !== null) erro(); return null }
  if (tipo === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) erro()
    const obrigatorios = s.required ?? []
    if (obrigatorios.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !Object.hasOwn(s.properties, k))) erro()
    return Object.fromEntries(Object.entries(v).filter(([k, x]) => !(x === null && !obrigatorios.includes(k)))
      .map(([k, x]) => [k, normalizarResultado(x, s.properties[k], `${caminho}.${k}`)]))
  }
  if (tipo === 'array') {
    if (!Array.isArray(v) || (s.maxItems !== undefined && v.length > s.maxItems) || (s.minItems !== undefined && v.length < s.minItems)) erro()
    return v.map((x, i) => normalizarResultado(x, s.items, `${caminho}[${i}]`))
  }
  if (tipo === 'integer' ? !Number.isInteger(v) : typeof v !== tipo) erro()
  if ((tipo === 'number' || tipo === 'integer') && !Number.isFinite(v)) erro()
  if (s.enum && !s.enum.includes(v)) erro()
  return v
}
