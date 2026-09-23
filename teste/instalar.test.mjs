import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gerar, instalar, chavesAceitas, NUCLEO } from '../instalar.mjs'
import { executar, plano } from './simulador.mjs'

const nucleo = readFileSync(NUCLEO, 'utf8')

function projetoTemporario(config) {
  const raiz = mkdtempSync(join(tmpdir(), 'missao-'))
  mkdirSync(join(raiz, '.git'))
  if (config) {
    mkdirSync(join(raiz, '.claude'))
    writeFileSync(join(raiz, '.claude', 'missao.config.json'), JSON.stringify(config))
  }
  return raiz
}

test('chaves aceitas vêm do PADRAO do núcleo', () => {
  assert.deepEqual(chavesAceitas(nucleo).sort(), [
    'exemplosSkills', 'formatoCommit', 'idioma', 'leitor', 'proibicoesExtras', 'regrasProjeto',
    'regrasTestes', 'revisor', 'revisoresPorPasta',
  ])
})

test('gerado começa com meta e embute a configuração', () => {
  const gerado = gerar(nucleo, { revisor: 'reviewer' }, 'abc1234')
  assert.ok(gerado.startsWith('export const meta = {'))
  assert.match(gerado, /const CONFIG_PROJETO = \{\n {2}"revisor": "reviewer"\n\}/)
  assert.match(gerado, /gerado por claude-missao abc1234/)
})

test('configuração com $ não é interpretada como padrão de substituição', () => {
  const gerado = gerar(nucleo, { formatoCommit: '$& $1' })
  assert.match(gerado, /"formatoCommit": "\$& \$1"/)
})

test('chave desconhecida é recusada na instalação', () => {
  assert.throws(() => gerar(nucleo, { revisorr: 'x' }), /chaves desconhecidas na configuração: revisorr/)
})

test('tipo errado é recusado na instalação', () => {
  assert.throws(() => gerar(nucleo, { revisor: 123 }), /tipo inválido na configuração: revisor/)
  assert.throws(() => gerar(nucleo, { proibicoesExtras: 'x' }), /proibicoesExtras \(esperado lista\)/)
  assert.throws(() => gerar(nucleo, { idioma: null }), /idioma \(esperado texto\)/)
})

test('núcleo salvo com CRLF continua instalável', () => {
  const gerado = gerar(nucleo.replace(/\n/g, '\r\n'), { revisor: 'reviewer' })
  assert.match(gerado, /"revisor": "reviewer"/)
})

test('instala, verifica e o arquivo instalado executa com a configuração do projeto', async () => {
  const raiz = projetoTemporario({ revisor: 'reviewer', leitor: 'explorer' })
  const { destino } = instalar(raiz)
  assert.equal(instalar(raiz, { verificar: true }).atualizado, true)

  const instalado = readFileSync(destino, 'utf8').replace('export const meta', 'const meta')
  const r = await executar(instalado, plano())
  assert.equal(r.resultado.concluido, true)
  assert.equal(r.tipo('revisão: F1'), 'reviewer')
  assert.equal(r.tipo('conferência'), 'explorer')

  writeFileSync(destino, readFileSync(destino, 'utf8') + '\n// editado à mão\n')
  assert.equal(instalar(raiz, { verificar: true }).atualizado, false)
})

test('não sobrescreve missao.js mantido à mão, salvo --forcar', () => {
  const raiz = projetoTemporario()
  mkdirSync(join(raiz, '.claude', 'workflows'), { recursive: true })
  const destino = join(raiz, '.claude', 'workflows', 'missao.js')
  writeFileSync(destino, '// versão manual\n')
  assert.throws(() => instalar(raiz), /não foi gerado pelo instalador/)
  assert.equal(readFileSync(destino, 'utf8'), '// versão manual\n')
  instalar(raiz, { forcar: true })
  assert.match(readFileSync(destino, 'utf8'), /gerado por claude-missao/)
  instalar(raiz)
})

test('sem configuração no projeto, instala o padrão', () => {
  const raiz = projetoTemporario()
  const { destino } = instalar(raiz)
  assert.match(readFileSync(destino, 'utf8'), /const CONFIG_PROJETO = \{\}/)
})

test('recusa pasta que não é raiz de repositório', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'missao-'))
  assert.throws(() => instalar(raiz), /não parece ser a raiz de um repositório git/)
})
