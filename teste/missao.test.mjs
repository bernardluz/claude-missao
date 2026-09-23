import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { executar, carregar, plano } from './simulador.mjs'
import { readFileSync } from 'node:fs'
import { NUCLEO, gerar } from '../instalar.mjs'

const fonte = carregar(NUCLEO)
const rodar = (args, opcoes, estado) => executar(fonte, args, opcoes, estado)
// Configuração do projeto entra como na instalação real: embutida em CONFIG_PROJETO.
const rodarCom = (config, args, opcoes) =>
  executar(gerar(readFileSync(NUCLEO, 'utf8'), config).replace('export const meta', 'const meta'), args, opcoes)
const CONFIG_EXEMPLO = {
  revisor: 'reviewer',
  revisoresPorPasta: [{ prefixo: 'services/', agentType: 'kotlin-reviewer' }],
  leitor: 'explorer',
  proibicoesExtras: ['variáveis PROJ_SKIP_*'],
  regrasTestes: 'docs/testes.md',
  regrasProjeto: 'AGENTS.md',
}

describe('fluxo principal', () => {
  test('caminho feliz: um commit por feature e agentes iguais à estimativa', async () => {
    const r = await rodar(plano())
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.commits, 3)
    assert.equal(r.agentes, 2 + 3 * 3 + 4 * 2 + 3)
    assert.equal(r.contar('suíte completa'), 1)
    assert.match(r.logs.find(l => l.startsWith('Estimativa')), new RegExp(`${r.agentes} agentes`))
    assert.equal(r.contar('revisão: F'), 3)
    assert.equal(r.contar('commit: '), 3)
  })

  test('revisão da feature reprova uma vez: ajuste e nova revisão antes do commit', async () => {
    const r = await rodar(plano(), { revisaoFeature: { F1: [2, 0] } })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('F1 · ajuste'), 1)
    assert.equal(r.contar('revisão: F1'), 2)
    assert.equal(r.commits, 3)
  })

  test('revisão da feature não fecha no teto: para sem commitar e explica o diff pendente', async () => {
    const r = await rodar(plano(), { revisaoFeature: { F1: [1, 1, 1, 1] } })
    assert.equal(r.resultado.parouEm, 'M1')
    assert.match(r.resultado.motivo, /não fechou após 3 rodadas/)
    assert.match(r.resultado.motivo, /ficou sem commit/)
    assert.equal(r.commits, 0)
  })

  test('gate do commit falha: vira ajuste, passa pela revisão e commita', async () => {
    const r = await rodar(plano(), { gate: { F2: 1 } })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('F2 · ajuste'), 1)
    assert.match(r.prompt('F2 · ajuste 1'), /gate do commit falhou/)
  })

  test('mudança fora da lista vira ajuste em vez de parar', async () => {
    const r = await rodar(plano(), { foraDaLista: { F1: 1 } })
    assert.equal(r.resultado.concluido, true)
    assert.match(r.prompt('F1 · ajuste 1'), /fora da lista/)
  })

  test('worker sem arquivos declarados para logo', async () => {
    const r = await rodar(plano(), { semArquivos: true })
    assert.match(r.resultado.motivo, /não declarou arquivos/)
    assert.equal(r.contar('revisão: '), 0)
  })
})

describe('loop de validação e correção', () => {
  test('continua enquanto os problemas diminuem', async () => {
    const r = await rodar(plano(), { validacao: [3, 2, 1, 0] })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.resultado.relatorio[0].rodadasCorrecao, 3)
  })

  test('para quando não há progresso', async () => {
    const r = await rodar(plano(), { validacao: [2, 2] })
    assert.match(r.resultado.motivo, /sem progresso na rodada 1: 2 problemas antes, 2 depois/)
  })

  test('respeita o teto de rodadas', async () => {
    const r = await rodar(plano({ maxRodadasCorrecao: 2 }), { validacao: [3, 2, 1] })
    assert.match(r.resultado.motivo, /não fechou após 2 rodadas/)
  })

  test('correções também passam por revisão e commit', async () => {
    const r = await rodar(plano(), { validacao: [2, 0] })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('revisão: correção'), 2)
    assert.equal(r.contar('commit: correção'), 2)
    assert.equal(r.commits, 5)
  })

  test('correção já resolvida não commita', async () => {
    const r = await rodar(plano(), { validacao: [2, 0], jaResolvidoCorrecao: true })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.commits, 3)
  })
})

describe('suíte completa final', () => {
  test('roda uma vez depois do último milestone', async () => {
    const r = await rodar(plano())
    const ordem = r.chamadas.map(c => c.label)
    assert.ok(ordem.indexOf('suíte completa') > ordem.lastIndexOf('revisão: M2'))
    assert.match(r.prompt('suíte completa'), /do que a missão tocou e de quem depende disso/)
    assert.match(r.prompt('suíte completa'), /git diff --name-only base0000\.\.HEAD/)
    assert.equal(r.resultado.relatorio.at(-1).milestone, 'Suíte final')
  })

  test('falha vira correção com revisão e commit, e a suíte roda de novo', async () => {
    const r = await rodar(plano(), { suite: [2, 0] })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('suíte completa'), 2)
    assert.equal(r.contar('commit: correção 1.1 (Suíte final)'), 1)
    assert.match(r.prompt('correção 1.1 (Suíte final)'), /Falha da suíte completa ao fim da missão/)
    assert.equal(r.commits, 5)
  })

  test('sem progresso na suíte, para e permite retomar direto nela', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { suite: [2, 2] }, estado)
    assert.equal(p1.resultado.parouEm, 'Suíte final')
    assert.equal(p1.resultado.retomar.aPartirDe, 'Suíte final')
    assert.equal(p1.resultado.retomar.inicioMissao, 'base0000')
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.match(p2.prompt('suíte completa'), /base0000\.\.HEAD/)
    assert.equal(p2.resultado.base, 'base0000')
    assert.equal(p2.contar('F'), 0)
    assert.equal(p2.contar('revisão: M'), 0)
    assert.equal(p2.contar('suíte completa'), 1)
  })

  test('falha de ambiente para sem gerar correção', async () => {
    const r = await rodar(plano(), { suiteAmbiente: true })
    assert.equal(r.resultado.parouEm, 'Suíte final')
    assert.match(r.resultado.motivo, /por causa do ambiente: Docker fora do ar/)
    assert.equal(r.contar('correção'), 0)
  })

  test('retomar só a suíte não chama o agente de skills', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { suite: [2, 2] }, estado)
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.contar('skills da missão'), 0)
    assert.equal(p2.resultado.concluido, true)
  })

  test('prompt da suíte pede agrupar falhas e limpar o que ela gerou', async () => {
    const r = await rodar(plano())
    assert.match(r.prompt('suíte completa'), /um problema por causa, não um por teste/)
    assert.match(r.prompt('suíte completa'), /desfaça somente o que a própria suíte criou ou alterou/)
  })

  test('correções não podem enfraquecer testes', async () => {
    const r = await rodar(plano(), { suite: [1, 0] })
    assert.match(r.prompt('correção 1.1 (Suíte final)'), /não desative, pule nem enfraqueça testes/)
  })

  test('substitui {inicio} na instrução configurada', async () => {
    const r = await rodarCom({ suiteCompleta: 'gate --base {inicio}' }, plano())
    assert.match(r.prompt('suíte completa'), /gate --base base0000\./)
  })

  test('usa o comando configurado no projeto', async () => {
    const r = await rodarCom({ suiteCompleta: 'npm run verify' }, plano())
    assert.match(r.prompt('suíte completa'), /de quem depende disso: npm run verify\. Intervalo da missão: base0000\.\.HEAD\./)
  })

  test('título de milestone reservado é recusado', async () => {
    const p = { milestones: [{ titulo: 'Suíte final', criterio: 'c', features: [{ titulo: 'F', spec: 's' }] }] }
    await assert.rejects(rodar(p), /"Suíte final" é reservado/)
  })
})

describe('quedas de agente', () => {
  test('worker cai sem rastro: retenta', async () => {
    const r = await rodar(plano(), { quedas: { F2: 1 } })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('F2'), 2 + r.contar('F2 ·'))
  })

  test('worker cai deixando diff parcial: o próximo continua dele', async () => {
    const r = await rodar(plano(), { quedas: { F2: 1 }, efeitoDaQueda: { F2: 'suja' } })
    assert.equal(r.resultado.concluido, true)
    const tentativas = r.chamadas.filter(c => c.label === 'F2')
    assert.match(tentativas[1].prompt, /trabalho parcial/)
  })

  test('worker cai mexendo no histórico: para', async () => {
    const r = await rodar(plano(), { quedas: { F2: 1 }, efeitoDaQueda: { F2: 'commitaOrfao' } })
    assert.match(r.resultado.motivo, /mexeu no histórico/)
  })

  test('agente de commit cai depois de commitar: adota o commit', async () => {
    const r = await rodar(plano(), { quedas: { 'commit: F1': 1 }, efeitoDaQueda: { 'commit: F1': 'commita' } })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('commit: F1'), 1)
    assert.equal(r.commits, 3)
  })

  test('agente de commit cai antes de commitar: retenta', async () => {
    const r = await rodar(plano(), { quedas: { 'commit: F1': 1 } })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('commit: F1'), 2)
  })

  test('agente da suíte completa cai uma vez: retenta', async () => {
    const r = await rodar(plano(), { quedas: { 'suíte completa': 1 } })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('suíte completa'), 2)
  })

  test('validador cai uma vez: retenta', async () => {
    const r = await rodar(plano(), { quedas: { 'revisão: M1': 1 } })
    assert.equal(r.resultado.concluido, true)
  })

  test('sem retentativas, a queda para a missão', async () => {
    const r = await rodar(plano({ maxRetentativasInfra: 0 }), { quedas: { F1: 1 } })
    assert.match(r.resultado.motivo, /não retornou após 1 tentativas/)
  })
})

describe('retomada', () => {
  test('retoma do milestone interrompido sem refazer o que foi commitado', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { validacao: [2, 2] }, estado)
    assert.equal(p1.resultado.parouEm, 'M1')
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.equal(p2.contar('F1'), 0)
    assert.equal(p2.contar('F2'), 0)
    assert.match(p2.prompt('revisão: M1'), new RegExp(`base0000\\.\\.${p1.resultado.retomar.head}`))
  })

  test('recusa retomar se apareceu commit alheio e devolve o retomar original', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { validacao: [2, 2] }, estado)
    estado.git.push('alheio00')
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.match(p2.resultado.motivo, /repositório mudou desde a parada/)
    assert.deepEqual(p2.resultado.retomar, p1.resultado.retomar)
  })

  test('retomada no meio preserva o início da missão para a suíte final', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { validacao: [0, 2, 2] }, estado)
    assert.equal(p1.resultado.parouEm, 'M2')
    assert.equal(p1.resultado.retomar.inicioMissao, 'base0000')
    assert.notEqual(p1.resultado.retomar.base, 'base0000')
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.match(p2.prompt('suíte completa'), /base0000\.\.HEAD/)
  })

  test('recusa retomar inválido', async () => {
    await assert.rejects(rodar(plano({ retomar: { aPartirDe: 'MX', base: 'base0000' } })), /args.retomar inválido/)
  })
})

describe('validação do plano', () => {
  test('milestone acima do limite é recusado', async () => {
    await assert.rejects(rodar(plano({ maxFeaturesPorMilestone: 1 })), /milestones acima de 1 features/)
  })

  test('títulos repetidos são recusados', async () => {
    const p = { milestones: [{ titulo: 'M', criterio: 'c', features: [{ titulo: 'F', spec: 's' }, { titulo: 'F', spec: 's' }] }] }
    await assert.rejects(rodar(p), /títulos de feature repetidos: F/)
  })

  test('limites inválidos são recusados', async () => {
    await assert.rejects(rodar(plano({ maxRodadasCorrecao: 0 })), /args inválido/)
  })
})

describe('configuração do projeto', () => {
  test('sem configuração: agente padrão e textos genéricos', async () => {
    const r = await rodar(plano())
    assert.equal(r.tipo('revisão: F1'), undefined)
    assert.equal(r.tipo('conferência'), undefined)
    assert.match(r.prompt('F1'), /runner já adotado no projeto/)
    assert.doesNotMatch(r.prompt('F1'), /exigida pelo/)
  })

  test('configuração aplica revisores, leitor, regras e proibições', async () => {
    const r = await rodarCom(CONFIG_EXEMPLO, plano())
    assert.equal(r.tipo('revisão: F1'), 'reviewer')
    assert.equal(r.tipo('revisão: M1'), 'reviewer')
    assert.equal(r.tipo('conferência'), 'explorer')
    assert.equal(r.tipo('skills da missão'), 'explorer')
    assert.match(r.prompt('F1'), /Siga docs\/testes\.md/)
    assert.match(r.prompt('F1'), /exigida pelo AGENTS\.md/)
    assert.match(r.prompt('commit: F1'), /PROJ_SKIP_\*/)
  })

  test('revisor por pasta vale com caminhos absolutos do Windows e do Git Bash', async () => {
    for (const caminho of ['C:\\repo\\services\\a.kt', '/c/repo/services/a.kt', './services/a.kt']) {
      const r = await rodarCom(CONFIG_EXEMPLO, plano(), { arquivos: [caminho], arquivosGit: ['services/a.kt'] })
      assert.equal(r.resultado.concluido, true, caminho)
      assert.equal(r.tipo('revisão: F1'), 'kotlin-reviewer', caminho)
      assert.equal(r.tipo('revisão: M1'), 'kotlin-reviewer', caminho)
    }
  })

  test('adoção de commit funciona com caminho absoluto', async () => {
    const r = await rodar(plano(), {
      arquivos: ['C:\\repo\\x\\a.js'], arquivosGit: ['x/a.js'],
      quedas: { 'commit: F1': 1 }, efeitoDaQueda: { 'commit: F1': 'commita' },
    })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('commit: F1'), 1)
  })

  test('formato inválido de revisoresPorPasta é recusado ao rodar', async () => {
    await assert.rejects(rodarCom({ revisoresPorPasta: [{ prefixo: 'a/' }] }, plano()), /revisoresPorPasta/)
  })

  test('args.config não desliga revisor nem proibições do projeto', async () => {
    for (const config of [{ revisor: null }, { proibicoesExtras: [] }, { revisoresPorPasta: [] }, { leitor: null }]) {
      await assert.rejects(rodarCom(CONFIG_EXEMPLO, plano({ config })), /args.config só ajusta/, JSON.stringify(config))
    }
  })

  test('args.config ajusta textos numa execução', async () => {
    const r = await rodarCom(CONFIG_EXEMPLO, plano({ config: { formatoCommit: 'feat(x): y', idioma: 'en' } }))
    assert.match(r.prompt('commit: F1'), /mensagem feat\(x\): y em en/)
    assert.match(r.prompt('commit: F1'), /PROJ_SKIP_\*/)
  })
})
