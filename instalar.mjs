// Instala o workflow missao num projeto.
// Lê <projeto>/.claude/missao.config.json (opcional) e gera <projeto>/.claude/workflows/missao.js
// com a configuração embutida em CONFIG_PROJETO.
//
// Uso:
//   node instalar.mjs <caminho-do-projeto>              gera ou atualiza a cópia instalada
//   node instalar.mjs <caminho-do-projeto> --verificar  sai com código 1 se a cópia estiver desatualizada
//   node instalar.mjs <caminho-do-projeto> --forcar     substitui um missao.js que não foi gerado pelo instalador
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const aqui = dirname(fileURLToPath(import.meta.url))
export const NUCLEO = join(aqui, 'missao.js')
const BLOCO = /\/\/ @config-inicio[^\n]*\nconst CONFIG_PROJETO = [\s\S]*?\n\/\/ @config-fim/
const MARCA = 'gerado por claude-missao'
const lf = texto => texto.replace(/\r\n/g, '\n')

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

export function gerar(nucleo, config, origem = '') {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('a configuração deve ser um objeto JSON')
  nucleo = lf(nucleo)
  const tipos = padraoDoNucleo(nucleo)
  const desconhecidas = Object.keys(config).filter(k => !(k in tipos))
  if (desconhecidas.length) throw new Error(`chaves desconhecidas na configuração: ${desconhecidas.join(', ')} (aceitas: ${Object.keys(tipos).join(', ')})`)
  const tipoErrado = Object.keys(config).filter(k => !TIPO_OK[tipos[k]](config[k]))
  if (tipoErrado.length) throw new Error(`tipo inválido na configuração: ${tipoErrado.map(k => `${k} (esperado ${tipos[k]})`).join(', ')}`)
  if (!BLOCO.test(nucleo)) throw new Error('marcadores @config-inicio/@config-fim não encontrados no núcleo')
  const cabecalho = `// @config-inicio (${MARCA}${origem ? ` ${origem}` : ''}; edite .claude/missao.config.json e reinstale)`
  return nucleo.replace(BLOCO, () => `${cabecalho}\nconst CONFIG_PROJETO = ${JSON.stringify(config, null, 2)}\n// @config-fim`)
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
  const gerado = gerar(readFileSync(NUCLEO, 'utf8'), config, origemAtual())
  const destino = join(raiz, '.claude', 'workflows', 'missao.js')

  if (verificar) {
    const atual = existsSync(destino) ? readFileSync(destino, 'utf8') : null
    return { destino, atualizado: atual !== null && semOrigem(atual) === semOrigem(gerado) }
  }
  // Não sobrescreve um missao.js mantido à mão: só o que este instalador gerou, salvo --forcar.
  if (!forcar && existsSync(destino) && !readFileSync(destino, 'utf8').includes(MARCA)) {
    throw new Error(`${destino} não foi gerado pelo instalador; revise e use --forcar para substituí-lo`)
  }
  mkdirSync(dirname(destino), { recursive: true })
  writeFileSync(destino, gerado)
  return { destino, config: existsSync(arquivoConfig) ? arquivoConfig : null }
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
      console.log(r.atualizado ? `atualizado: ${r.destino}` : `desatualizado ou ausente: ${r.destino}`)
      process.exit(r.atualizado ? 0 : 1)
    }
    const r = instalar(projeto, { forcar: opcoes.includes('--forcar') })
    console.log(`instalado: ${r.destino}${r.config ? ` (configuração: ${r.config})` : ' (sem configuração do projeto; usando o padrão)'}`)
  } catch (erro) {
    console.error(`erro: ${erro.message}`)
    process.exit(1)
  }
}
