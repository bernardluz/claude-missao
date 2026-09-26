import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { gerar, instalar, instalarGlobal, skillGlobal, chavesAceitas, lerEtapas, lerAprendizados, NUCLEO, SKILLS, ETAPAS_DIR } from '../instalar.mjs'
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
    'exemplosSkills', 'formatoCommit', 'idioma', 'leitor', 'modeloConferencia', 'preVoo', 'proibicoesExtras', 'regrasProjeto',
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
  assert.deepEqual(e.contagem, { commits: 1, arquivos: 1, pendencias: e.pendencias.length })
  assert.deepEqual(estado('HEAD').commits, [])
  assert.equal(instalar(raiz, { verificar: true }).atualizado, true)
  writeFileSync(join(raiz, '.claude', 'missao', 'git-estado.mjs'), 'manual\n')
  assert.equal(instalar(raiz, { verificar: true }).atualizado, false)
  assert.throws(() => instalar(raiz), /git-estado\.mjs não foi gerado pelo instalador/)
})

test('embute a técnica de cada etapa; o projeto complementa ou substitui, e etapa desconhecida é recusada', () => {
  const raiz = projetoTemporario()
  const dir = join(raiz, '.claude', 'missao', 'etapas')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'implementar.md'), 'Use o Maven wrapper.\n')
  writeFileSync(join(dir, 'aceite.md'), '<!-- substitui -->\nSó o do projeto.\n')
  const etapas = lerEtapas(raiz)
  assert.deepEqual(Object.keys(etapas).filter(k => !k.endsWith('.enxugar')), ['aceite', 'caca-bug', 'corrigir', 'implementar', 'planejar', 'pre-voo',
    'prova-de-contrato', 'revisar', 'scrutiny', 'ui-ux', 'user-testing'])
  const nucleoImplementar = readFileSync(join(ETAPAS_DIR, 'implementar.md'), 'utf8').replace(/\r\n/g, '\n').trim()
  assert.equal(etapas.implementar, `${nucleoImplementar}\n\nDo projeto:\nUse o Maven wrapper.`)
  assert.equal(etapas.aceite, 'Só o do projeto.')
  const { destino } = instalar(raiz)
  const instalado = readFileSync(destino, 'utf8')
  assert.match(instalado, /const ETAPAS = \{\n {2}"aceite": "Só o do projeto\.",/)
  assert.ok(instalado.includes(JSON.stringify(etapas.implementar)))
  assert.equal(instalar(raiz, { verificar: true }).atualizado, true)
  writeFileSync(join(dir, 'implementar.md'), 'Outra regra.\n')
  assert.equal(instalar(raiz, { verificar: true }).atualizado, false)
  writeFileSync(join(dir, 'deploy.md'), 'x')
  assert.throws(() => instalar(raiz), /etapa desconhecida: .*deploy\.md/)
})

test('complemento de etapa salvo com BOM ainda reconhece <!-- substitui -->', () => {
  const raiz = projetoTemporario()
  const dir = join(raiz, '.claude', 'missao', 'etapas')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'aceite.md'), '﻿<!-- substitui -->\r\nSó o do projeto.\r\n')
  assert.equal(lerEtapas(raiz).aceite, 'Só o do projeto.')
})

test('git-estado.mjs no modo compacto une os arquivos da missão sem os commits de fora', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'missao-git-'))
  const git = (...a) => execFileSync('git', ['-C', raiz, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' })
  const commit = (arquivo, msg) => {
    mkdirSync(dirname(join(raiz, arquivo)), { recursive: true })
    writeFileSync(join(raiz, arquivo), msg)
    git('add', arquivo)
    git('commit', '-q', '-m', msg)
    return git('rev-parse', 'HEAD').trim()
  }
  git('init', '-q', '-b', 'principal')
  const inicio = commit('base.txt', 'base')
  const m1 = commit('m1/a.txt', 'm1')
  const fora = commit('fora/x.txt', 'fora')
  commit('m2/b.txt', 'm2')
  instalar(raiz)
  const rodar = (...a) => JSON.parse(execFileSync('node', ['.claude/missao/git-estado.mjs', ...a], { cwd: raiz, encoding: 'utf8' }))
  const e = rodar(inicio, '--resumo', m1, fora.slice(0, 7))
  assert.equal(e.resumo, true)
  assert.equal(e.arquivosPorCommit, undefined)
  assert.equal(e.commits.length, 3)
  assert.deepEqual(e.arquivos, ['m1/a.txt', 'm2/b.txt'])
  assert.deepEqual(e.arquivosDoMilestone, ['m2/b.txt'])
  assert.deepEqual(e.contagem, { commits: 3, arquivos: 2, arquivosDoMilestone: 1, pendencias: e.pendencias.length })
  assert.deepEqual(rodar(inicio, '--resumo', inicio).arquivosDoMilestone, ['m1/a.txt', 'fora/x.txt', 'm2/b.txt'])
})

test('git-estado.mjs no modo compacto une os arquivos da missão sem os commits de fora', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'missao-git-'))
  const git = (...a) => execFileSync('git', ['-C', raiz, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' })
  const commit = (arquivo, msg) => {
    mkdirSync(dirname(join(raiz, arquivo)), { recursive: true })
    writeFileSync(join(raiz, arquivo), msg)
    git('add', arquivo)
    git('commit', '-q', '-m', msg)
    return git('rev-parse', 'HEAD').trim()
  }
  git('init', '-q', '-b', 'principal')
  const inicio = commit('base.txt', 'base')
  const m1 = commit('m1/a.txt', 'm1')
  const fora = commit('fora/x.txt', 'fora')
  commit('m2/b.txt', 'm2')
  instalar(raiz)
  const rodar = (...a) => JSON.parse(execFileSync('node', ['.claude/missao/git-estado.mjs', ...a], { cwd: raiz, encoding: 'utf8' }))
  const e = rodar(inicio, '--resumo', m1, fora.slice(0, 7))
  assert.equal(e.resumo, true)
  assert.equal(e.arquivosPorCommit, undefined)
  assert.equal(e.commits.length, 3)
  assert.deepEqual(e.arquivos, ['m1/a.txt', 'm2/b.txt'])
  assert.deepEqual(e.arquivosDoMilestone, ['m2/b.txt'])
  assert.deepEqual(e.contagem, { commits: 3, arquivos: 2, arquivosDoMilestone: 1, pendencias: e.pendencias.length })
  assert.deepEqual(rodar(inicio, '--resumo', inicio).arquivosDoMilestone, ['m1/a.txt', 'fora/x.txt', 'm2/b.txt'])
})

test('embute .claude/missao/aprendizados.md (BOM e CRLF tratados) e a verificação acusa mudança nele', () => {
  const raiz = projetoTemporario()
  const arquivo = join(raiz, '.claude', 'missao', 'aprendizados.md')
  mkdirSync(dirname(arquivo), { recursive: true })
  writeFileSync(arquivo, '﻿- Rode com forks=1.\r\n- Banking devolve 404 sem acesso.\r\n')
  assert.equal(lerAprendizados(raiz), '- Rode com forks=1.\n- Banking devolve 404 sem acesso.')
  const { destino } = instalar(raiz)
  assert.ok(readFileSync(destino, 'utf8').includes(`const APRENDIZADOS_PROJETO = ${JSON.stringify(lerAprendizados(raiz))}`))
  assert.equal(instalar(raiz, { verificar: true }).atualizado, true)
  writeFileSync(arquivo, '- Outro.\n')
  assert.equal(instalar(raiz, { verificar: true }).atualizado, false)
  assert.equal(lerAprendizados(projetoTemporario()), '')
})

test('aprendizados.md acima de 60 linhas gera aviso, sem falhar a instalação', () => {
  const raiz = projetoTemporario()
  const arquivo = join(raiz, '.claude', 'missao', 'aprendizados.md')
  mkdirSync(dirname(arquivo), { recursive: true })
  writeFileSync(arquivo, Array.from({ length: 60 }, (_, i) => `- item ${i}`).join('\n'))
  assert.deepEqual(instalar(raiz).avisos, [])
  writeFileSync(arquivo, Array.from({ length: 61 }, (_, i) => `- item ${i}`).join('\n'))
  const r = instalar(raiz)
  assert.equal(r.avisos.length, 1)
  assert.match(r.avisos[0], /tem 61 linhas \(teto recomendado: 60\)/)
  assert.equal(instalar(raiz, { verificar: true }).avisos.length, 1)
  const cli = spawnSync('node', [NUCLEO.replace(/missao\.js$/, 'instalar.mjs'), raiz], { encoding: 'utf8' })
  assert.equal(cli.status, 0)
  assert.match(cli.stderr, /^aviso: .*tem 61 linhas/m)
})

test('git-estado.mjs lista os arquivos de dentro de pasta nova, não a pasta', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'missao-git-'))
  const git = (...a) => execFileSync('git', ['-C', raiz, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' })
  git('init', '-q', '-b', 'principal')
  writeFileSync(join(raiz, 'a.txt'), '1')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'base')
  instalar(raiz)
  git('add', '.claude')
  git('commit', '-q', '-m', 'missao')
  mkdirSync(join(raiz, 'pkg', 'novo'), { recursive: true })
  writeFileSync(join(raiz, 'pkg', 'novo', 'A.kt'), 'x')
  writeFileSync(join(raiz, 'pkg', 'novo', 'B.kt'), 'y')
  const e = JSON.parse(execFileSync('node', ['.claude/missao/git-estado.mjs', 'HEAD'], { cwd: raiz, encoding: 'utf8' }))
  assert.deepEqual(e.pendencias.sort(), ['?? pkg/novo/A.kt', '?? pkg/novo/B.kt'])
  assert.equal(e.contagem.pendencias, 2)
})

test('instalação por projeto não grava skills: só missao.js e git-estado.mjs', () => {
  const raiz = projetoTemporario()
  instalar(raiz)
  assert.equal(existsSync(join(raiz, '.claude', 'skills')), false)
  assert.ok(existsSync(join(raiz, '.claude', 'workflows', 'missao.js')))
  assert.ok(existsSync(join(raiz, '.claude', 'missao', 'git-estado.mjs')))
  assert.equal(instalar(raiz, { verificar: true }).atualizado, true)
})

test('--global grava criar-spec-simples e enxugar-codigo no Claude e no Codex, com caminho e origin injetados', () => {
  const home = mkdtempSync(join(tmpdir(), 'missao-home-'))
  const repo = 'C:/repos/claude-missao'
  const r = instalarGlobal({ home, repo, origem: 'https://example.test/claude-missao.git' })
  assert.equal(r.destinos.length, 4)
  assert.deepEqual(SKILLS.map(([nome]) => nome), ['criar-spec-simples', 'enxugar-codigo'])
  for (const base of ['.claude', '.codex']) {
    assert.equal(existsSync(join(home, base, 'skills', 'missao-traycer')), false, base)
    for (const [nome] of SKILLS) {
      const texto = readFileSync(join(home, base, 'skills', nome, 'SKILL.md'), 'utf8')
      assert.match(texto, new RegExp(`^---\\nname: ${nome}\\n`), `${base} ${nome}`)
      assert.doesNotMatch(texto, /\{\{CLAUDE_MISSAO\}\}/, `${base} ${nome}`)
      assert.match(texto, /## Atualizar a missão\n\nRepositório: `C:\/repos\/claude-missao` \(origin: https:\/\/example\.test\/claude-missao\.git\)\./)
      assert.match(texto, /1\. `git -C "C:\/repos\/claude-missao" pull`/)
      assert.match(texto, /2\. `node "C:\/repos\/claude-missao\/instalar\.mjs" --global`/)
      assert.match(texto, /`node "C:\/repos\/claude-missao\/instalar\.mjs" <projeto> --verificar`; se estiver desatualizado,\n {3}`node "C:\/repos\/claude-missao\/instalar\.mjs" <projeto>`/)
    }
  }
})

test('--global remove a missao-traycer do global só quando a cópia tem a marca do instalador', () => {
  const home = mkdtempSync(join(tmpdir(), 'missao-home-'))
  const marcada = join(home, '.claude', 'skills', 'missao-traycer', 'SKILL.md')
  const manual = join(home, '.codex', 'skills', 'missao-traycer', 'SKILL.md')
  for (const [arquivo, texto] of [[marcada, 'Instalada pelo `claude-missao` no global\n'], [manual, 'minha versão\n']]) {
    mkdirSync(dirname(arquivo), { recursive: true })
    writeFileSync(arquivo, texto)
  }
  const r = instalarGlobal({ home, repo: 'C:/r', origem: '' })
  assert.deepEqual(r.removidos, [marcada])
  assert.equal(existsSync(dirname(marcada)), false)
  assert.equal(readFileSync(manual, 'utf8'), 'minha versão\n')
  // A ausência dela não deixa o global desatualizado.
  assert.equal(instalarGlobal({ home, repo: 'C:/r', origem: '', verificar: true }).atualizado, true)
})

test('--verificar sem projeto confere as skills globais', () => {
  const home = mkdtempSync(join(tmpdir(), 'missao-home-'))
  const opcoes = { home, repo: 'C:/r', origem: '' }
  assert.equal(instalarGlobal({ ...opcoes, verificar: true }).atualizado, false)
  instalarGlobal(opcoes)
  assert.equal(instalarGlobal({ ...opcoes, verificar: true }).atualizado, true)
  writeFileSync(join(home, '.codex', 'skills', 'enxugar-codigo', 'SKILL.md'), 'editada\n')
  assert.equal(instalarGlobal({ ...opcoes, verificar: true }).atualizado, false)
  assert.doesNotMatch(skillGlobal('x {{CLAUDE_MISSAO}}', 'C:/r', ''), /origin/)
})

test('instala os complementos .enxugar das etapas', () => {
  const raiz = projetoTemporario()
  const { destino } = instalar(raiz)
  const etapas = lerEtapas(raiz)
  assert.deepEqual(Object.keys(etapas).filter(k => k.endsWith('.enxugar')), ['aceite.enxugar', 'caca-bug.enxugar',
    'corrigir.enxugar', 'implementar.enxugar', 'planejar.enxugar', 'pre-voo.enxugar', 'prova-de-contrato.enxugar',
    'revisar.enxugar', 'scrutiny.enxugar', 'ui-ux.enxugar'])
  assert.ok(readFileSync(destino, 'utf8').includes(JSON.stringify(etapas['implementar.enxugar'])))
})
