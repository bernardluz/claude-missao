// Instala o workflow missao num projeto.
// Lê <projeto>/.claude/missao.config.json (opcional) e gera <projeto>/.claude/workflows/missao.js
// com a configuração embutida em CONFIG_PROJETO. Copia também, sem alterar, os arquivos de COPIAS: a skill
// missao-traycer (lê a configuração do projeto ao rodar), a skill criar-spec-simples e o script de estado do git que a
// conferência roda. Embute a técnica de cada etapa (etapas/ + .claude/missao/etapas/ do projeto) em ETAPAS.
//
// Uso:
//   node instalar.mjs <caminho-do-projeto>              gera ou atualiza a cópia instalada
//   node instalar.mjs <caminho-do-projeto> --verificar  sai com código 1 se a cópia estiver desatualizada
//   node instalar.mjs <caminho-do-projeto> --forcar     substitui um missao.js que não foi gerado pelo instalador
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const aqui = dirname(fileURLToPath(import.meta.url))
export const NUCLEO = join(aqui, 'missao.js')
export const SKILL = join(aqui, 'skills', 'missao-traycer', 'SKILL.md')
// Arquivos copiados como estão: origem no claude-missao → destino relativo à raiz do projeto. Cada um traz a marca
// MARCA_COPIA, para o instalador não sobrescrever uma versão mantida à mão.
export const COPIAS = [
  [SKILL, '.claude/skills/missao-traycer/SKILL.md'],
  [join(aqui, 'skills', 'criar-spec-simples', 'SKILL.md'), '.claude/skills/criar-spec-simples/SKILL.md'],
  [join(aqui, 'git-estado.mjs'), '.claude/missao/git-estado.mjs'],
]
const MARCA_COPIA = '`claude-missao`'
const BLOCO = /\/\/ @config-inicio[^\n]*\nconst CONFIG_PROJETO = [\s\S]*?\n\/\/ @config-fim/
const BLOCO_ETAPAS = /\/\/ @etapas-inicio[^\n]*\nconst ETAPAS = [\s\S]*?\n\/\/ @etapas-fim/
const MARCA = 'gerado por claude-missao'
// Sem BOM e com LF: arquivo salvo no Windows não pode esconder o marcador <!-- substitui -->.
const lf = texto => texto.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')

// Técnica de cada etapa: etapas/<etapa>.md no claude-missao. O projeto complementa em .claude/missao/etapas/<etapa>.md;
// o texto dele vai depois do núcleo, ou o substitui quando a primeira linha é SUBSTITUI.
export const ETAPAS_DIR = join(aqui, 'etapas')
const SUBSTITUI = '<!-- substitui -->'
const mds = dir => readdirSync(dir).filter(n => n.endsWith('.md')).map(n => n.slice(0, -3)).sort()
export function lerEtapas(raizProjeto) {
  const etapas = Object.fromEntries(mds(ETAPAS_DIR).map(n => [n, lf(readFileSync(join(ETAPAS_DIR, `${n}.md`), 'utf8')).trim()]))
  const dirProjeto = raizProjeto ? join(raizProjeto, '.claude', 'missao', 'etapas') : null
  if (!dirProjeto || !existsSync(dirProjeto)) return etapas
  for (const n of mds(dirProjeto)) {
    if (!(n in etapas)) throw new Error(`etapa desconhecida: ${join(dirProjeto, `${n}.md`)} (aceitas: ${Object.keys(etapas).join(', ')})`)
    const texto = lf(readFileSync(join(dirProjeto, `${n}.md`), 'utf8')).trim()
    etapas[n] = texto.startsWith(SUBSTITUI) ? texto.slice(SUBSTITUI.length).trim() : `${etapas[n]}\n\nDo projeto:\n${texto}`
  }
  return etapas
}

// As chaves e seus tipos vêm do PADRAO do núcleo, para não manter duas listas.
// null aceita texto ou null; texto exige texto; lista exige lista (o formato dos itens é validado ao rodar).
export function padraoDoNucleo(nucleo) {
  const bloco = lf(nucleo).match(/\nconst PADRAO = \{\n([\s\S]*?)\n\}\n/)
  if (!bloco) throw new Error('bloco PADRAO não encontrado no núcleo')
  return Object.fromEntries([...bloco[1].matchAll(/^ {2}(\w+): (null|\[|'|`)/gm)]
    .map(([, chave, inicio]) => [chave, inicio === 'null' ? 'textoOuNull' : inicio === '[' ? 'lista' : 'texto']))
}
export const chavesAceitas = nucleo => Object.keys(padraoDoNucleo(nucleo))

const TIPO_OK = {
  textoOuNull: v => v === null || typeof v === 'string',
  texto: v => typeof v === 'string',
  lista: v => Array.isArray(v),
}

export function gerar(nucleo, config, origem = '', etapas = lerEtapas()) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('a configuração deve ser um objeto JSON')
  nucleo = lf(nucleo)
  const tipos = padraoDoNucleo(nucleo)
  const desconhecidas = Object.keys(config).filter(k => !(k in tipos))
  if (desconhecidas.length) throw new Error(`chaves desconhecidas na configuração: ${desconhecidas.join(', ')} (aceitas: ${Object.keys(tipos).join(', ')})`)
  const tipoErrado = Object.keys(config).filter(k => !TIPO_OK[tipos[k]](config[k]))
  if (tipoErrado.length) throw new Error(`tipo inválido na configuração: ${tipoErrado.map(k => `${k} (esperado ${tipos[k]})`).join(', ')}`)
  if (!BLOCO.test(nucleo)) throw new Error('marcadores @config-inicio/@config-fim não encontrados no núcleo')
  if (!BLOCO_ETAPAS.test(nucleo)) throw new Error('marcadores @etapas-inicio/@etapas-fim não encontrados no núcleo')
  const cabecalho = `// @config-inicio (${MARCA}${origem ? ` ${origem}` : ''}; edite .claude/missao.config.json e reinstale)`
  return nucleo
    .replace(BLOCO, () => `${cabecalho}\nconst CONFIG_PROJETO = ${JSON.stringify(config, null, 2)}\n// @config-fim`)
    .replace(BLOCO_ETAPAS, () => '// @etapas-inicio (etapas/ do claude-missao + .claude/missao/etapas/ do projeto; reinstale)\n' +
      `const ETAPAS = ${JSON.stringify(etapas, null, 2)}\n// @etapas-fim`)
}

// A linha de origem muda a cada commit do claude-missao; a verificação compara só o conteúdo.
const semOrigem = texto => lf(texto).replace(/^\/\/ @config-inicio.*$/m, '// @config-inicio')

function origemAtual() {
  try {
    const sha = execFileSync('git', ['-C', aqui, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const sujo = execFileSync('git', ['-C', aqui, 'status', '--porcelain', '--', 'missao.js'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return sujo ? `${sha}+alterações` : sha
  } catch {
    return ''
  }
}

export function instalar(projeto, { verificar = false, forcar = false } = {}) {
  const raiz = resolve(projeto)
  if (!existsSync(join(raiz, '.git'))) throw new Error(`${raiz} não parece ser a raiz de um repositório git`)
  const arquivoConfig = join(raiz, '.claude', 'missao.config.json')
  const config = existsSync(arquivoConfig) ? JSON.parse(readFileSync(arquivoConfig, 'utf8')) : {}
  const gerado = gerar(readFileSync(NUCLEO, 'utf8'), config, origemAtual(), lerEtapas(raiz))
  const destino = join(raiz, '.claude', 'workflows', 'missao.js')
  const copias = COPIAS.map(([origem, relativo]) => ({ destino: join(raiz, relativo), conteudo: lf(readFileSync(origem, 'utf8')) }))
  const lerLf = arquivo => (existsSync(arquivo) ? lf(readFileSync(arquivo, 'utf8')) : null)
  const destinoSkill = copias[0].destino

  if (verificar) {
    const atual = lerLf(destino)
    const atualizado = atual !== null && semOrigem(atual) === semOrigem(gerado) && copias.every(c => lerLf(c.destino) === c.conteudo)
    return { destino, destinoSkill, atualizado }
  }
  // Não sobrescreve arquivo mantido à mão: só o que este instalador gerou, salvo --forcar.
  for (const [arquivo, marca] of [[destino, MARCA], ...copias.map(c => [c.destino, MARCA_COPIA])]) {
    if (!forcar && existsSync(arquivo) && !readFileSync(arquivo, 'utf8').includes(marca)) {
      throw new Error(`${arquivo} não foi gerado pelo instalador; revise e use --forcar para substituí-lo`)
    }
  }
  for (const [arquivo, conteudo] of [[destino, gerado], ...copias.map(c => [c.destino, c.conteudo])]) {
    mkdirSync(dirname(arquivo), { recursive: true })
    writeFileSync(arquivo, conteudo)
  }
  return { destino, destinoSkill, config: existsSync(arquivoConfig) ? arquivoConfig : null }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [projeto, ...opcoes] = process.argv.slice(2)
  if (!projeto) {
    console.error('uso: node instalar.mjs <caminho-do-projeto> [--verificar | --forcar]')
    process.exit(2)
  }
  try {
    if (opcoes.includes('--verificar')) {
      const r = instalar(projeto, { verificar: true })
      console.log(r.atualizado ? `atualizado: ${r.destino} e cópias` : `desatualizado ou ausente: ${r.destino} ou uma das cópias (${COPIAS.map(c => c[1]).join(', ')})`)
      process.exit(r.atualizado ? 0 : 1)
    }
    const r = instalar(projeto, { forcar: opcoes.includes('--forcar') })
    console.log(`instalado: ${r.destino} e ${COPIAS.map(c => c[1]).join(', ')}${r.config ? ` (configuração: ${r.config})` : ' (sem configuração do projeto; usando o padrão)'}`)
  } catch (erro) {
    console.error(`erro: ${erro.message}`)
    process.exit(1)
  }
}
