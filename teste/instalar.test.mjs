import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { gerar, instalar, chavesAceitas, NUCLEO, SKILL } from '../instalar.mjs'
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
    'exemplosSkills', 'formatoCommit', 'idioma', 'leitor', 'modeloConferencia', 'proibicoesExtras', 'regrasProjeto',
    'regrasTestes', 'revisor', 'revisoresPorPasta', 'suiteCompleta',
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

test('instala a skill missao-traycer e a verificação acusa cópia editada', () => {
  const raiz = projetoTemporario()
  const { destinoSkill } = instalar(raiz)
  assert.equal(readFileSync(destinoSkill, 'utf8'), readFileSync(SKILL, 'utf8').replace(/\r\n/g, '\n'))
  assert.match(readFileSync(destinoSkill, 'utf8'), /^---\nname: missao-traycer\n/)
  writeFileSync(destinoSkill, readFileSync(destinoSkill, 'utf8') + '\neditada\n')
  assert.equal(instalar(raiz, { verificar: true }).atualizado, false)
  instalar(raiz)
  assert.equal(instalar(raiz, { verificar: true }).atualizado, true)
})

test('não sobrescreve skill mantida à mão, salvo --forcar', () => {
  const raiz = projetoTemporario()
  const destinoSkill = join(raiz, '.claude', 'skills', 'missao-traycer', 'SKILL.md')
  mkdirSync(dirname(destinoSkill), { recursive: true })
  writeFileSync(destinoSkill, 'manual\n')
  assert.throws(() => instalar(raiz), /não foi gerado pelo instalador/)
  assert.equal(readFileSync(destinoSkill, 'utf8'), 'manual\n')
  instalar(raiz, { forcar: true })
  assert.match(readFileSync(destinoSkill, 'utf8'), /name: missao-traycer/)
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

test('instala o git-estado.mjs, que imprime o JSON que a conferência interpreta', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'missao-git-'))
  const git = (...a) => execFileSync('git', ['-C', raiz, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' })
  git('init', '-q', '-b', 'principal')
  writeFileSync(join(raiz, 'a.txt'), '1')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD').trim()
  instalar(raiz)
  mkdirSync(join(raiz, 'pasta'))
  writeFileSync(join(raiz, 'pasta', 'b.txt'), '2')
  git('add', 'pasta/b.txt')
  git('commit', '-q', '-m', 'dois')
  writeFileSync(join(raiz, 'a.txt'), 'sujo')
  const estado = base => JSON.parse(execFileSync('node', ['.claude/missao/git-estado.mjs', base], { cwd: raiz, encoding: 'utf8' }))
  const e = estado(base)
  const head = git('rev-parse', 'HEAD').trim()
  assert.equal(e.head, head)
  assert.equal(e.branch, 'principal')
  assert.equal(e.limpo, false)
  assert.ok(e.pendencias.includes(' M a.txt'), JSON.stringify(e.pendencias))
  assert.deepEqual(e.commits, [head])
  assert.deepEqual(e.arquivos, ['pasta/b.txt'])
  assert.deepEqual(e.arquivosPorCommit, { [head]: ['pasta/b.txt'] })
  assert.deepEqual(estado('HEAD').commits, [])
  assert.equal(instalar(raiz, { verificar: true }).atualizado, true)
  writeFileSync(join(raiz, '.claude', 'missao', 'git-estado.mjs'), 'manual\n')
  assert.equal(instalar(raiz, { verificar: true }).atualizado, false)
  assert.throws(() => instalar(raiz), /git-estado\.mjs não foi gerado pelo instalador/)
})
