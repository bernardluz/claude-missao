import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { executar, carregar, plano, DUMP, MEDICAO_ANTES, MEDICAO_DEPOIS } from './simulador.mjs'
import { readFileSync } from 'node:fs'
import { NUCLEO, gerar, lerEtapas } from '../instalar.mjs'

const fonte = carregar(NUCLEO)
const rodar = (args, opcoes, estado) => executar(fonte, args, opcoes, estado)
// Configuração do projeto entra como na instalação real: embutida em CONFIG_PROJETO.
const rodarCom = (config, args, opcoes, estado) =>
  executar(gerar(readFileSync(NUCLEO, 'utf8'), config).replace('export const meta', 'const meta'), args, opcoes, estado)
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
    assert.equal(r.agentes, 3 + 4 * 3 + 8 * 2 + 5)
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

describe('conferência logo depois do commit', () => {
  test('cada commit é conferido a partir do HEAD anterior da missão', async () => {
    const r = await rodar(plano())
    const ordem = r.chamadas.map(c => c.label)
    const [f1, f2] = r.resultado.relatorio[0].features.map(x => x.commit)
    for (const [feature, antes] of [['F1', 'base0000'], ['F2', f1]]) {
      const i = ordem.indexOf(`commit: ${feature}`)
      assert.equal(ordem[i + 1], 'conferência', feature)
      assert.match(r.chamadas[i + 1].prompt, new RegExp(`node \\.claude/missao/git-estado\\.mjs ${antes}\``), feature)
    }
    assert.notEqual(f1, f2)
  })

  test('commit de fora antes do commit da feature: para com o sha, e o retomar ajustado segue', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { commitDeFora: { F2: 'fora0001' } }, estado)
    assert.equal(p1.resultado.parouEm, 'M1')
    assert.match(p1.resultado.motivo, /commit de fora da missão logo depois da feature "F2": fora0001\./)
    assert.match(p1.resultado.motivo, /git rev-list --reverse <retomar\.base>\.\.HEAD/)
    assert.match(p1.resultado.motivo, /e os SHAs de fora também em retomar\.deFora/)
    assert.equal(p1.contar('revisão: M1'), 0)
    const retomar = p1.resultado.retomar
    assert.deepEqual(retomar.concluidas, ['F1', 'F2'])
    assert.equal(retomar.head, estado.git.at(-1))
    assert.equal(retomar.commits.length, 2)
    // Sem ajuste, a retomada recusa: aceitar o commit de fora é decisão do usuário.
    const semAjuste = await rodar(plano({ retomar }), {}, estado)
    assert.match(semAjuste.resultado.motivo, /repositório mudou desde a parada/)
    // Ajuste que o motivo ensina: commits reais do intervalo e HEAD real.
    const p2 = await rodar(plano({ retomar: { ...retomar, commits: estado.git.slice(1), head: estado.git.at(-1) } }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.equal(p2.contar('F1'), 0)
    assert.equal(p2.contar('F2'), 0)
    assert.equal(p2.contar('F3'), 1)
  })

  test('commit de fora depois do commit da feature: motivo traz o sha e o HEAD real', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const r = await rodar(plano(), { commitDeFora: { 'commit: F1': 'fora0001' } }, estado)
    assert.match(r.resultado.motivo, /"F1": fora0001\./)
    assert.match(r.resultado.motivo, /retomar\.head o HEAD real, fora0001/)
    assert.equal(r.resultado.retomar.head, estado.git.at(-2))
    assert.deepEqual(r.resultado.retomar.concluidas, ['F1'])
    assert.equal(r.contar('F2'), 0)
  })

  test('commit de fora durante a validação: a conferência do milestone traz o sha', async () => {
    const r = await rodar(plano(), { commitDeFora: { 'testes: M1': 'fora0002' } })
    assert.equal(r.resultado.parouEm, 'M1')
    assert.match(r.resultado.motivo, /^após validação: commit de fora da missão em base0000\.\.HEAD: fora0002\./)
  })

  test('commit de fora que não impacta: aceito, entra nos commits esperados e a missão segue', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const r = await rodar(plano(), { commitDeFora: { F2: 'fora0001', 'testes: M2': 'fora0002' }, foraImpacta: false }, estado)
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('commit de fora'), 2)
    const juiz = r.chamadas.find(c => c.label === 'commit de fora')
    assert.equal(juiz.model, 'sonnet')
    assert.equal(juiz.effort, 'low')
    assert.match(juiz.prompt, /- fora0001: z\/fora\.js/)
    assert.match(juiz.prompt, /Arquivos do milestone atual: x\/a\.js/)
    assert.ok(r.logs.some(l => l.startsWith('commit de fora aceito, não impacta a missão: fora0001.')))
    assert.equal(r.resultado.head, estado.git.at(-1))
    assert.match(r.resultado.relatorio[1].commits, new RegExp(`\\.\\.${estado.git.at(-1)}$`))
  })

  test('commit de fora que impacta para; se toca arquivo da missão, para sem consultar o agente', async () => {
    const julgado = await rodar(plano(), { commitDeFora: { F2: 'fora0001' } })
    assert.match(julgado.resultado.motivo, /"F2": fora0001\..*julgado pelo agente$/)
    const tocando = await rodar(plano(), { commitDeFora: { F2: 'fora0001' }, arquivosDeFora: ['x/a.js'], foraImpacta: false })
    assert.match(tocando.resultado.motivo, /toca arquivo da missão: x\/a\.js$/)
    assert.equal(tocando.contar('commit de fora'), 0)
  })

  test('commit de fora que leva o diff da feature: para com o sha, sem mandar descartar diff', async () => {
    const r = await rodar(plano(), { commitDeForaTudo: { 'revisão: F1': 'fora0001' } })
    assert.match(r.resultado.motivo, /não commitou \(nada a commitar\), e base0000\.\.HEAD tem commit de fora da missão: fora0001,/)
    assert.match(r.resultado.motivo, /inclua também "F1" em retomar\.concluidas/)
    assert.doesNotMatch(r.resultado.motivo, /ficou sem commit/)
    assert.deepEqual(r.resultado.retomar.concluidas, [])
  })

  test('commit de fora com o diff da feature ainda na árvore: a parada lembra do diff', async () => {
    const r = await rodar(plano(), { commitDeFora: { 'revisão: F1': 'fora0001' }, falhaCommit: { F1: 'index.lock existe' } })
    assert.match(r.resultado.motivo, /não commitou \(index\.lock existe\), e base0000\.\.HEAD tem commit de fora da missão: fora0001,/)
    assert.match(r.resultado.motivo, /O diff da feature ficou sem commit/)
  })

  test('SHA declarado que não está no git não entra no retomar', async () => {
    const r = await rodar(plano(), { shaErrado: { F1: 'naoexiste' } })
    assert.match(r.resultado.motivo, /declarou naoexiste, mas base0000\.\.HEAD tem sha00001/)
    assert.deepEqual(r.resultado.retomar.concluidas, [])
    assert.deepEqual(r.resultado.retomar.commits, [])
  })

  test('commit com arquivo que a revisão não viu fica fora do retomar até o usuário decidir', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const opcoes = { arquivosGit: ['x/a.js', 'y/b.js'] }
    const p1 = await rodar(plano(), opcoes, estado)
    assert.match(p1.resultado.motivo, /commit de "F1", sha00001, tem arquivos fora da lista revisada: y\/b\.js\. Ele ficou fora do retomar/)
    const retomar = p1.resultado.retomar
    assert.deepEqual(retomar.concluidas, [])
    assert.deepEqual(retomar.commits, [])
    const semAjuste = await rodar(plano({ retomar }), opcoes, estado)
    assert.match(semAjuste.resultado.motivo, /repositório mudou desde a parada/)
    const aceito = { ...retomar, commits: estado.git.slice(1), head: estado.git.at(-1), concluidas: ['F1'] }
    const p2 = await rodar(plano({ retomar: aceito }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.equal(p2.contar('F1'), 0)
  })

  test('pasta nova declarada como no git status cobre os arquivos de dentro', async () => {
    const pasta = { arquivos: ['novo/'], arquivosGit: ['novo/a.js', 'novo/b.js'] }
    assert.equal((await rodar(plano(), pasta)).resultado.concluido, true)
    const adotado = await rodar(plano(), { ...pasta, quedas: { 'commit: F1': 1 }, efeitoDaQueda: { 'commit: F1': 'commita' } })
    assert.equal(adotado.resultado.concluido, true)
    assert.equal(adotado.contar('commit: F1'), 1)
  })

  test('árvore suja logo depois do commit para a missão, com as pendências no motivo', async () => {
    const r = await rodar(plano(), { suja: { 'commit: F1': 1 } })
    assert.match(r.resultado.motivo, /árvore com mudanças não commitadas depois do commit de "F1": M x\/a\.js/)
    assert.equal(r.contar('F2'), 0)
  })

  test('conferência lê o git pelo script, com modelo barato, e saída inválida repete a leitura', async () => {
    const r = await rodar(plano(), { conferenciaInvalida: 1 })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.chamadas[0].label, 'preparo')
    assert.match(r.prompt('preparo'), /node \.claude\/missao\/git-estado\.mjs HEAD`/)
    assert.ok(r.logs.some(l => /^preparo: saída de \.claude\/missao\/git-estado\.mjs inválida/.test(l)))
    assert.equal(r.contar('preparo'), 2)
    assert.equal(r.chamadas.find(c => c.label === 'conferência').model, 'haiku')
    const sempre = await rodar(plano(), { conferenciaInvalida: 99 })
    assert.equal(sempre.resultado.parouEm, 'preparo')
    assert.equal(sempre.contar('preparo'), 3)
    const comCerca = await rodar(plano(), { conferenciaComCerca: true })
    assert.equal(comCerca.resultado.concluido, true)
    assert.equal(comCerca.contar('preparo'), 1)
    const outroModelo = await rodarCom({ modeloConferencia: 'sonnet' }, plano())
    assert.equal(outroModelo.chamadas.find(c => c.label === 'conferência').model, 'sonnet')
  })

  test('conferência que não volta ou branch trocada logo depois do commit param a missão', async () => {
    const semLeitura = await rodar(plano(), { quedas: { conferência: 3 } })
    assert.match(semLeitura.resultado.motivo, /conferência logo depois do commit de "F1" não retornou; o commit declarado, sha00001/)
    assert.deepEqual(semLeitura.resultado.retomar.concluidas, ['F1'])
    const outraBranch = await rodar(plano(), { branchNaConferencia: 'outra' })
    assert.match(outraBranch.resultado.motivo, /branch mudou para "outra" logo depois do commit de "F1"/)
  })

  test('dump logo depois do commit é tolerado na conferência e apagado no commit seguinte', async () => {
    const r = await rodar(plano(), { dump: { 'commit: F1': 1 } })
    assert.equal(r.resultado.concluido, true)
    const i = r.logs.indexOf(`dump de crash do bash na raiz, tolerado como artefato do ambiente: ${DUMP}`)
    assert.ok(i >= 0 && i < r.logs.indexOf(`F2: agente de commit apagou dump de crash do bash: ${DUMP}`))
  })
})

describe('agente de commit', () => {
  test('recusa do harness para a missão, mesmo junto de gate, sem virar ajuste', async () => {
    for (const recusa of [{ motivo: 'Credential Leakage' }, { motivo: 'Credential Leakage', gateFalhou: true }]) {
      const r = await rodar(plano(), { recusa: { F1: recusa } })
      assert.equal(r.resultado.parouEm, 'M1')
      assert.match(r.resultado.motivo, /recusou um comando do agente de commit.*: Credential Leakage\./)
      assert.match(r.resultado.motivo, /ficou sem commit/)
      assert.equal(r.contar('F1 · ajuste'), 0)
      assert.equal(r.contar('commit: F1'), 1)
      assert.equal(r.commits, 0)
    }
  })

  test('recusa depois do commit: o commit entra no retomar e a missão para', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const r = await rodar(plano(), { recusa: { F1: { motivo: 'Credential Leakage', commita: true } } }, estado)
    assert.match(r.resultado.motivo, /: Credential Leakage\. O commit da feature, sha00001, já entrou em retomar/)
    assert.doesNotMatch(r.resultado.motivo, /ficou sem commit/)
    assert.deepEqual(r.resultado.retomar.concluidas, ['F1'])
    assert.equal(r.resultado.retomar.head, estado.git.at(-1))
    assert.equal(r.contar('F2'), 0)
  })

  test('prompt proíbe contornar recusa', async () => {
    const p = (await rodar(plano())).prompt('commit: F1')
    assert.match(p, /recusar uma ferramenta ou um comando, não tente de outro jeito/)
    assert.match(p, /devolva recusado=true, o texto da recusa em motivo e commitado=false, ou commitado=true com o SHA/)
  })

  test('prompts que rodam build, testes ou gates mandam a saída para arquivo, nunca por pipe', async () => {
    const r = await rodar(plano(), { revisaoFeature: { F1: [1, 0] } })
    for (const label of ['F1', 'F1 · ajuste 1', 'revisão: F1', 'commit: F1', 'revisão: M1', 'testes: M1', 'suíte completa']) {
      assert.match(r.prompt(label), /<comando> > "\$log" 2>&1; echo "saida=\$\?"; tail -40 "\$log"/, label)
      assert.match(r.prompt(label), /Nunca leia a saída por pipe \(`\| tail`, `\| head`, `\| tee`\): um daemon/, label)
    }
    assert.match(r.prompt('commit: F1'), /git commit -F <arquivo> -- <paths> > "\$log" 2>&1; echo "saida=\$\?"; tail -40 "\$log"/)
  })
})

describe('dump de crash do bash', () => {
  test('agente de commit apaga o dump e a missão registra no log, sem ajuste', async () => {
    const r = await rodar(plano(), { dump: { F1: 1 } })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('F1 · ajuste'), 0)
    assert.ok(r.logs.includes(`F1: agente de commit apagou dump de crash do bash: ${DUMP}`))
    assert.deepEqual(r.estado.dumps, [])
    assert.match(r.prompt('commit: F1'), /`\*\.stackdump` não rastreado na raiz .* apague-o, informe o caminho em descartados/)
  })

  test('dump listado como fora da lista não vira apontamento: o commit é repetido', async () => {
    const r = await rodar(plano(), { dump: { F1: 1 }, ignoraDump: { F1: 1 } })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('F1 · ajuste'), 0)
    assert.equal(r.contar('revisão: F1'), 1)
    const tentativas = r.chamadas.filter(c => c.label === 'commit: F1')
    assert.equal(tentativas.length, 2)
    assert.match(tentativas[1].prompt, /listou bash\.exe\.stackdump como fora da lista: é dump de crash do bash/)
  })

  test('agente que insiste em listar o dump para a missão sem ajuste', async () => {
    const r = await rodar(plano(), { dump: { F1: 1 }, ignoraDump: { F1: 2 } })
    assert.match(r.resultado.motivo, /não apagou o dump de crash do bash \(bash\.exe\.stackdump\)/)
    assert.equal(r.contar('F1 · ajuste'), 0)
  })

  test('dump junto de mudança alheia: só a mudança alheia vira apontamento', async () => {
    const r = await rodar(plano(), { dump: { F1: 1 }, ignoraDump: { F1: 1 }, foraDaLista: { F1: 1 } })
    assert.equal(r.resultado.concluido, true)
    const ajuste = r.prompt('F1 · ajuste 1')
    assert.match(ajuste, /fora da lista da feature: y\/b\.js\./)
    assert.doesNotMatch(ajuste, /stackdump/)
  })

  test('dump que sobra no fim do milestone é tolerado na conferência e apagado no commit seguinte', async () => {
    const r = await rodar(plano(), { dump: { 'commit: F2': 1 } })
    assert.equal(r.resultado.concluido, true)
    const i = r.logs.indexOf(`dump de crash do bash na raiz, tolerado como artefato do ambiente: ${DUMP}`)
    assert.ok(i >= 0 && i < r.logs.indexOf(`F3: agente de commit apagou dump de crash do bash: ${DUMP}`))
  })

  test('dump junto de mudança real ou fora da raiz não é tolerado', async () => {
    const junto = await rodar(plano(), { dump: { 'commit: F2': 1 }, suja: { 'commit: F2': 1 } })
    assert.match(junto.resultado.motivo, /árvore com mudanças não commitadas.*: M x\/a\.js, \?\? bash\.exe\.stackdump$/)
    const naPasta = await rodar(plano(), { dump: { 'commit: F2': 1 }, caminhoDump: 'x/bash.exe.stackdump' })
    assert.match(naPasta.resultado.motivo, /árvore com mudanças não commitadas.*: \?\? x\/bash\.exe\.stackdump$/)
  })

  test('dump na raiz não impede começar a missão', async () => {
    const r = await rodar(plano(), {}, { git: ['base0000'], sujo: false, dumps: [DUMP] })
    assert.equal(r.resultado.concluido, true)
    assert.deepEqual(r.estado.dumps, [])
  })

  test('dump tolerado na adoção do commit e na retentativa do worker', async () => {
    const adotado = await rodar(plano(), {
      quedas: { 'commit: F1': 1 }, efeitoDaQueda: { 'commit: F1': 'commita' }, dump: { 'commit: F1': 1 },
    })
    assert.equal(adotado.resultado.concluido, true)
    assert.equal(adotado.contar('commit: F1'), 1)
    const worker = await rodar(plano(), { quedas: { F2: 1 }, dump: { F2: 1 } })
    assert.equal(worker.resultado.concluido, true)
    assert.doesNotMatch(worker.chamadas.filter(c => c.label === 'F2')[1].prompt, /trabalho parcial/)
  })

  test('dump declarado pelo worker ou pelo ajuste sai da lista da feature, e a revisão o ignora', async () => {
    const r = await rodar(plano(), { arquivos: ['x/a.js', DUMP], arquivosGit: ['x/a.js'] })
    assert.equal(r.resultado.concluido, true)
    assert.match(r.prompt('commit: F1'), /Arquivos da feature: x\/a\.js\.\n/)
    assert.match(r.prompt('revisão: F1'), /`\*\.stackdump` não rastreado na raiz .*: ignore-o\./)
    const ajuste = await rodar(plano(), { revisaoFeature: { F1: [1, 0] }, arquivosAjuste: ['x/a.js', DUMP], arquivosGit: ['x/a.js'] })
    assert.equal(ajuste.resultado.concluido, true)
    assert.match(ajuste.prompt('commit: F1'), /Arquivos da feature: x\/a\.js\.\n/)
  })

  test('agente de commit que apaga além do dump para a missão', async () => {
    const r = await rodar(plano(), { dump: { F1: 1 }, apagaAlem: { F1: ['hs_err_pid1.log'] } })
    assert.match(r.resultado.motivo, /apagou o que não é dump de crash do bash: hs_err_pid1\.log\. O commit da feature, sha00001, já entrou em retomar/)
    assert.ok(r.logs.includes(`F1: agente de commit apagou dump de crash do bash: ${DUMP}`))
    assert.deepEqual(r.resultado.retomar.concluidas, ['F1'])
    // Apagado a mais na tentativa que listou o dump não se perde na repetição do commit.
    const naRepeticao = await rodar(plano(), { dump: { F1: 1 }, ignoraDump: { F1: 1 }, apagaAlem: { F1: ['notas.txt'] } })
    assert.match(naRepeticao.resultado.motivo, /apagou o que não é dump de crash do bash: notas\.txt\. Decida à mão/)
    assert.equal(naRepeticao.contar('commit: F1'), 1)
  })

  test('arquivo temporário fora do repositório não conta como apagado a mais', async () => {
    const temporarios = ['/tmp/tmp.Ab12Cd', 'C:\\Users\\x\\AppData\\Local\\Temp\\msg.txt', '/c/Users/x/AppData/Local/Temp/log.txt']
    const r = await rodar(plano(), { dump: { F1: 1 }, apagaAlem: { F1: temporarios } })
    assert.equal(r.resultado.concluido, true)
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

  test('retomar só a suíte não chama o agente do contexto do plano', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { suite: [2, 2] }, estado)
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.contar('contexto do plano'), 0)
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

  test('worker cai mexendo no histórico: para com o sha e como aceitar commit de fora', async () => {
    const r = await rodar(plano(), { quedas: { F2: 1 }, efeitoDaQueda: { F2: 'commitaOrfao' } })
    assert.match(r.resultado.motivo, /histórico mudou \(.*1 commit\(s\) novo\(s\): orfao000\), por commit dele ou de fora da missão/)
    assert.match(r.resultado.motivo, /retomar\.head o HEAD real, orfao000/)
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
    assert.equal(r.tipo('contexto do plano'), 'explorer')
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

describe('etapas, contexto do plano e aprendizados', () => {
  const AREAS = [{ nome: 'Área X', guia: 'copie x/modelo.js', features: ['F1', 'F2', 'F3'] }]

  test('cada prompt de etapa traz a técnica da etapa embutida na instalação e o contexto da área', async () => {
    const r = await rodarCom({}, plano(), { areas: AREAS, validacao: [1, 0], revisaoFeature: { F1: [1, 0] } })
    assert.equal(r.resultado.concluido, true)
    const etapa = nome => readFileSync(new URL(`../etapas/${nome}.md`, import.meta.url), 'utf8').split('\n')[0]
    for (const [label, nome] of [['F1', 'implementar'], ['F1 · ajuste 1', 'implementar'], ['revisão: F1', 'revisar'],
      ['revisão: M1', 'scrutiny'], ['testes: M1', 'scrutiny'], ['correção 1.1 (M1)', 'corrigir'], ['suíte completa', 'scrutiny']]) {
      assert.ok(r.prompt(label).includes(`Técnica da etapa ${nome}`), label)
      assert.ok(r.prompt(label).includes(etapa(nome)), label)
      assert.match(r.prompt(label), /### Área X\ncopie x\/modelo\.js/, label)
    }
    assert.doesNotMatch(r.prompt('commit: F1'), /Técnica da etapa/)
  })

  test('núcleo sem instalação não tem técnica embutida, mas segue funcionando', async () => {
    const r = await rodar(plano())
    assert.doesNotMatch(r.prompt('F1'), /Técnica da etapa/)
  })

  test('contexto do plano é gerado uma vez e volta no resultado e no retomar; a retomada o reaproveita', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { areas: AREAS, validacao: [2, 2] }, estado)
    assert.equal(p1.contar('contexto do plano'), 1)
    assert.deepEqual(p1.resultado.contexto.areas, AREAS)
    assert.deepEqual(p1.resultado.retomar.contexto.areas, AREAS)
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.equal(p2.contar('contexto do plano'), 0)
    assert.match(p2.prompt('F3'), /### Área X/)
  })

  test('aprendizados dos workers vão para os próximos prompts, para o retomar e para o resultado', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const aprendizados = { F1: ['rode com forks=1'], 'revisão: F2': ['o Banking devolve 404 sem acesso', 'rode com forks=1'] }
    const p1 = await rodar(plano(), { aprendizados, validacao: [0, 2, 2] }, estado)
    assert.doesNotMatch(p1.prompt('F1'), /Aprendizados desta missão/)
    assert.match(p1.prompt('F2'), /Aprendizados desta missão:\n- rode com forks=1/)
    assert.match(p1.prompt('F1'), /Em aprendizados, devolva só técnica ou armadilha durável.*Nunca estado do momento: HEAD, contagem de testes/)
    assert.deepEqual(p1.resultado.aprendizados, ['rode com forks=1', 'o Banking devolve 404 sem acesso'])
    assert.deepEqual(p1.resultado.retomar.contexto.aprendizados, p1.resultado.aprendizados)
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.match(p2.prompt('revisão: M2'), /- o Banking devolve 404 sem acesso/)
    assert.deepEqual(p2.resultado.aprendizados, p1.resultado.aprendizados)
  })
})

describe('spec, planejamento e pré-voo', () => {
  const comSpec = (extra = {}) => ({ spec: 'docs/spec.md', ...extra })

  test('plano direto pula simplicidade e planejamento; args.plano também serve', async () => {
    const direto = await rodar(plano())
    assert.equal(direto.contar('simplicidade') + direto.contar('planejar'), 0)
    const r = await rodar({ plano: { milestones: plano().milestones } })
    assert.equal(r.resultado.concluido, true)
    assert.deepEqual(r.resultado.plano.milestones.map(m => m.titulo), ['M1', 'M2'])
  })

  test('sem plano nem spec, args é recusado', async () => {
    await assert.rejects(rodar({}), /args inválido/)
  })

  test('simplicidade com perguntas ou cortes para antes de planejar, devolvendo tudo junto', async () => {
    const r = await rodar(comSpec(), { perguntas: ['a fila é mesmo assíncrona?'], cortes: ['tabela de histórico sem uso'] })
    assert.equal(r.resultado.parouEm, 'simplicidade')
    assert.deepEqual(r.resultado.perguntas, ['a fila é mesmo assíncrona?'])
    assert.deepEqual(r.resultado.cortes, ['tabela de histórico sem uso'])
    assert.match(r.resultado.motivo, /nenhum código foi escrito/)
    assert.equal(r.contar('planejar'), 0)
    assert.equal(r.commits, 0)
    assert.match(r.prompt('simplicidade'), /SPEC \(texto, ou caminho de arquivo no repositório para ler inteiro\):\ndocs\/spec\.md/)
  })

  test('spec aprovada: plano gerado executa e volta no resultado e no retomar; a retomada não replaneja', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const gerado = [{ titulo: 'G1', criterio: 'c', caca: [], userTesting: ' ', features: [{ titulo: 'H1', spec: 's' }] }]
    const p1 = await rodar(comSpec(), { planoGerado: gerado, suite: [2, 2] }, estado)
    assert.equal(p1.contar('simplicidade'), 1)
    assert.equal(p1.contar('planejar'), 1)
    assert.equal(p1.resultado.parouEm, 'Suíte final')
    assert.deepEqual(p1.resultado.retomar.plano, { milestones: [{ titulo: 'G1', criterio: 'c', features: [{ titulo: 'H1', spec: 's' }] }] })
    const p2 = await rodar(comSpec({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.equal(p2.contar('simplicidade') + p2.contar('planejar'), 0)
    assert.deepEqual(p2.resultado.plano, p1.resultado.retomar.plano)
  })

  test('plano gerado inválido para sem código', async () => {
    const r = await rodar(comSpec(), { planoGerado: [{ titulo: 'Suíte final', criterio: 'c', features: [{ titulo: 'H', spec: 's' }] }] })
    assert.equal(r.resultado.parouEm, 'planejar')
    assert.match(r.resultado.motivo, /plano gerado não serve: "Suíte final" é reservado/)
    assert.equal(r.commits, 0)
  })

  test('pré-voo que falha para antes de qualquer commit, com o que falta e um retomar que recomeça do início', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodarCom({ preVoo: 'Docker vivo e -Dbrivae.test.forks=1' }, plano(), { preVooFalta: ['Docker parado: rode docker info'] }, estado)
    assert.equal(p1.resultado.parouEm, 'pré-voo')
    assert.match(p1.resultado.motivo, /o ambiente não está pronto: Docker parado: rode docker info/)
    assert.deepEqual(p1.resultado.faltando, ['Docker parado: rode docker info'])
    assert.equal(p1.contar('F1'), 0)
    assert.equal(p1.commits, 0)
    assert.match(p1.prompt('pré-voo'), /Docker vivo e -Dbrivae\.test\.forks=1/)
    assert.equal(p1.resultado.retomar.aPartirDe, 'M1')
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.equal(p2.contar('pré-voo'), 1)
    // A parada no pré-voo não tinha contexto: a retomada o gera em vez de reaproveitar um vazio.
    assert.deepEqual(p1.resultado.retomar.contexto.areas, [])
    assert.equal(p2.contar('contexto do plano'), 1)
  })
})

describe('prova de contrato, caça bug e user testing por milestone', () => {
  const comEtapas = extra => ({
    ...extra,
    milestones: [
      { titulo: 'M1', criterio: 'c', caca: ['autorização', 'persistência'], userTesting: 'abre a tela e salva', features: [{ titulo: 'F1', spec: 's' }] },
      { titulo: 'M2', criterio: 'c', features: [{ titulo: 'F2', spec: 's' }] },
    ],
  })

  test('ordem por milestone: contrato, implementar, scrutiny, caça por área, user testing', async () => {
    const r = await rodar(comEtapas())
    assert.equal(r.resultado.concluido, true)
    const ordem = r.chamadas.map(c => c.label)
    const pos = l => ordem.indexOf(l)
    assert.ok(pos('contrato: M1') < pos('F1'))
    assert.ok(pos('revisão: M1') < pos('caça: autorização (M1, rodada 1)'))
    assert.ok(pos('caça: persistência (M1, rodada 1)') < pos('user testing: M1'))
    assert.ok(pos('user testing: M1') < pos('contrato: M2'))
    assert.equal(r.contar('áreas de caça: M1'), 0)
    assert.equal(r.chamadas.find(c => c.label === 'áreas de caça: M2').model, 'haiku')
    assert.equal(r.contar('caça: geral (M2, rodada 1)'), 1)
    assert.equal(r.contar('user testing: M2'), 0)
    assert.match(r.logs.find(l => l.startsWith('Estimativa')), new RegExp(`${r.agentes} agentes`))
    assert.equal(r.chamadas.find(c => c.label === 'revisão: M1').phase, 'Scrutiny')
  })

  test('prova de contrato com premissa falsa para antes de implementar, com todas as perguntas juntas', async () => {
    const contratoFalso = { M1: [
      { premissa: 'GET /contas devolve id', confere: false, pergunta: 'usar idConta?' },
      { premissa: 'campo saldo', confere: true },
      { premissa: '404 sem acesso', confere: false },
    ] }
    const r = await rodar(comEtapas(), { contratoFalso })
    assert.equal(r.resultado.parouEm, 'M1')
    assert.match(r.resultado.motivo, /prova de contrato: 2 premissa\(s\)/)
    assert.deepEqual(r.resultado.perguntas, ['usar idConta?', 'confirmar: 404 sem acesso'])
    assert.equal(r.contar('F1'), 0)
    assert.equal(r.resultado.retomar.aPartirDe, 'M1')
  })

  test('achado confirmado pelos dois verificadores vira correção, passa pelo scrutiny e a caça volta; rodada vazia encerra', async () => {
    const r = await rodar(comEtapas(), { caca: { M1: [1, 0] } })
    assert.equal(r.resultado.concluido, true)
    // 2 áreas × 1 achado = 2 achados, 2 verificadores cada
    assert.equal(r.contar('verificação '), 4)
    assert.equal(r.contar('commit: correção 1.1 (M1)'), 1)
    assert.equal(r.contar('commit: correção 1.2 (M1)'), 1)
    const ordem = r.chamadas.map(c => c.label)
    assert.ok(ordem.indexOf('commit: correção 1.2 (M1)') < ordem.lastIndexOf('revisão: M1'))
    assert.ok(ordem.lastIndexOf('revisão: M1') < ordem.indexOf('caça: autorização (M1, rodada 2)'))
    assert.equal(r.contar('caça: autorização (M1, rodada 3)'), 0)
    assert.match(r.prompt('caça: autorização (M1, rodada 2)'), /Já corrigidos nesta missão [^\n]*\n1\. x\/a\.js bug 1\.1/)
    assert.match(r.prompt('verificação 1: achado 1 (M1, rodada 1)'), /Tente refutar este possível bug .*: x\/a\.js bug 1\.1/)
  })

  test('achado refutado por um verificador não vira correção', async () => {
    const r = await rodar(comEtapas(), { caca: { M1: [1] }, refuta: true })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('correção'), 0)
    assert.equal(r.contar('caça: autorização (M1, rodada 2)'), 0)
  })

  test('bug confirmado de novo depois de corrigido para a missão pedindo decisão', async () => {
    const r = await rodar(comEtapas(), { caca: { M1: [1, 1] }, cacaRepete: { M1: 2 } })
    assert.equal(r.resultado.parouEm, 'M1')
    assert.match(r.resultado.motivo, /confirmou de novo bug já corrigido/)
    assert.equal(r.contar('correção 2.'), 0)
  })

  test('caça respeita o teto de rodadas e segue', async () => {
    const r = await rodar(comEtapas({ maxRodadasCaca: 2 }), { caca: { M1: [1, 1, 1] } })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('caça: autorização (M1, rodada 3)'), 0)
    assert.ok(r.logs.some(l => /M1: teto de 2 rodadas de caça bug/.test(l)))
  })

  test('user testing que falha vira correção, volta ao scrutiny e testa de novo', async () => {
    const r = await rodar(comEtapas(), { userTesting: { M1: [1, 0] } })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('user testing: M1'), 2)
    const ordem = r.chamadas.map(c => c.label)
    const correcao = ordem.indexOf('commit: correção 1.1 (M1)')
    assert.ok(correcao > ordem.indexOf('user testing: M1'))
    assert.ok(ordem.indexOf('revisão: M1', correcao) < ordem.lastIndexOf('user testing: M1'))
    assert.match(r.prompt('user testing: M1'), /abre a tela e salva/)
    assert.match(r.prompt('user testing: M1'), /nunca aponte para produção/)
  })

  test('user testing sem progresso para', async () => {
    const r = await rodar(comEtapas(), { userTesting: { M1: [1, 1] } })
    assert.match(r.resultado.motivo, /sem progresso na rodada 1: 1 problemas antes, 1 depois/)
  })
})

describe('caça final e aceite', () => {
  test('caça final roda sobre a missão inteira antes da suíte, e o aceite vem depois dela', async () => {
    const r = await rodar(plano())
    assert.equal(r.resultado.concluido, true)
    const ordem = r.chamadas.map(c => c.label)
    const final = ordem.indexOf('caça: interação entre milestones (final, rodada 1)')
    assert.ok(final > ordem.lastIndexOf('revisão: M2') && final < ordem.indexOf('suíte completa'))
    assert.match(r.prompt('caça: interação entre milestones (final, rodada 1)'), /git diff base0000\.\.sha00003/)
    assert.ok(ordem.indexOf('aceite') > ordem.indexOf('suíte completa'))
    assert.deepEqual(r.resultado.aceite, [{ criterio: 'c ok', evidencia: 'teste T passou', atendido: true }])
    assert.match(r.prompt('aceite'), /Critérios de aceite \(os dos milestones\):\n- M1: c\n- M2: c/)
  })

  test('achado confirmado na caça final vira correção e a suíte roda em seguida', async () => {
    const r = await rodar(plano(), { caca: { final: [1] } })
    assert.equal(r.resultado.concluido, true)
    const ordem = r.chamadas.map(c => c.label)
    assert.ok(ordem.indexOf('commit: correção 1.1 (Suíte final)') < ordem.indexOf('suíte completa'))
    assert.equal(r.contar('caça: interação entre milestones'), 1)
  })

  test('com um só milestone ou retomando na suíte final, não há caça final', async () => {
    const um = await rodar({ milestones: [plano().milestones[0]] })
    assert.equal(um.contar('caça: interação'), 0)
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { suite: [2, 2] }, estado)
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.contar('caça: interação'), 0)
    assert.match(p2.logs.find(l => l.startsWith('Estimativa')), new RegExp(`${p2.agentes} agentes`))
  })

  test('critério sem evidência vira correção uma vez, com suíte de novo; resolvido, conclui', async () => {
    const r = await rodar(plano({ aceite: ['POST /x sem permissão devolve 403'] }), { aceiteFalta: [1, 0] })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('aceite'), 2)
    assert.equal(r.contar('suíte completa'), 2)
    assert.match(r.prompt('correção 1.1 (Suíte final)'), /critério de aceite sem evidência: c1\. sem teste/)
    assert.match(r.prompt('aceite'), /Critérios de aceite:\n- POST \/x sem permissão devolve 403/)
  })

  test('critério que continua sem evidência termina a missão reportando o que faltou', async () => {
    const r = await rodar(plano(), { aceiteFalta: [1, 1] })
    assert.equal(r.resultado.parouEm, 'Suíte final')
    assert.match(r.resultado.motivo, /critérios de aceite sem evidência mesmo depois de uma correção: c1/)
    assert.deepEqual(r.resultado.faltou.map(c => c.criterio), ['c1'])
    assert.equal(r.contar('aceite'), 2)
  })

  test('com spec, o aceite usa a seção de aceite da SPEC', async () => {
    const r = await rodar({ spec: 'docs/spec.md' })
    assert.equal(r.resultado.concluido, true)
    assert.match(r.prompt('aceite'), /docs\/spec\.md\n\nUse os critérios de aceite da SPEC/)
  })

  test('aceite inválido é recusado', async () => {
    await assert.rejects(rodar(plano({ aceite: 'tudo' })), /args inválido/)
  })
})

describe('revisão: retomada e commits de fora', () => {
  test('na retomada, commit de fora que toca arquivo de milestone anterior para, sem consultar o agente', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { validacao: [0, 2, 2] }, estado)
    assert.equal(p1.resultado.parouEm, 'M2')
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {
      commitDeFora: { 'revisão: M2': 'fora0001' }, arquivosDeFora: ['x/a.js'], foraImpacta: false,
    }, estado)
    assert.equal(p2.resultado.parouEm, 'M2')
    assert.match(p2.resultado.motivo, /toca arquivo da missão: x\/a\.js$/)
    assert.equal(p2.contar('commit de fora'), 0)
    assert.match(p2.prompt('conferência'), /git-estado\.mjs base0000 --resumo sha\d{5}`/)
  })

  test('commit de fora aceito vai no retomar e não conta como arquivo da missão na retomada', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { commitDeFora: { F2: 'fora0001' }, arquivosDeFora: ['z/fora.js'], foraImpacta: false, validacao: [0, 2, 2] }, estado)
    assert.equal(p1.resultado.parouEm, 'M2')
    assert.deepEqual(p1.resultado.retomar.deFora, ['fora0001'])
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {
      commitDeFora: { 'revisão: M2': 'fora0002' }, arquivosDeFora: ['z/fora.js'], foraImpacta: false,
    }, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.equal(p2.contar('commit de fora'), 1)
    // A retomada lê a missão no modo compacto do script, passando os commits de fora já aceitos.
    assert.match(p2.prompt('conferência'), /git-estado\.mjs base0000 --resumo sha\d{5} fora0001`/)
  })
})

describe('revisão: commit de fora aceito fica fora do escopo', () => {
  test('arquivos do commit de fora não entram no revisor por pasta, nas áreas de caça nem nas correções', async () => {
    const r = await rodarCom(CONFIG_EXEMPLO, plano(), {
      arquivos: ['services/a.kt'], commitDeFora: { F2: 'fora0001' }, arquivosDeFora: ['web/y.ts'], foraImpacta: false,
      validacao: [1, 0],
    })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.tipo('revisão: M1'), 'kotlin-reviewer')
    assert.doesNotMatch(r.prompt('áreas de caça: M1'), /web\/y\.ts/)
    assert.match(r.prompt('áreas de caça: M1'), /services\/a\.kt/)
    for (const label of ['revisão: M1', 'testes: M1', 'correção 1.1 (M1)', 'caça: geral (M1, rodada 1)']) {
      assert.match(r.prompt(label), /Ignore os commits de fora da missão \(fora0001\)/, label)
    }
  })
})

describe('revisão: estado que atravessa a retomada', () => {
  test('contexto sem áreas (agente caiu) é gerado de novo na retomada', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { quedas: { 'contexto do plano': 3 }, validacao: [2, 2] }, estado)
    assert.deepEqual(p1.resultado.retomar.contexto.areas, [])
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), { areas: [{ nome: 'A', guia: 'g', features: ['F3'] }] }, estado)
    assert.equal(p2.contar('contexto do plano'), 1)
    assert.match(p2.prompt('F3'), /### A\ng/)
  })

  test('parada durante a caça final: a retomada na suíte final faz a caça final', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const label = 'caça: interação entre milestones (final, rodada 1)'
    const p1 = await rodar(plano(), { quedas: { [label]: 3 } }, estado)
    assert.equal(p1.resultado.parouEm, 'Suíte final')
    assert.equal(p1.resultado.retomar.cacaFinalFeita, false)
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.equal(p2.contar(label), 1)
    assert.match(p2.logs.find(l => l.startsWith('Estimativa')), new RegExp(`${p2.agentes} agentes`))
  })

  test('bugs corrigidos vão no retomar: bug repetido é detectado depois da retomada', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { caca: { M1: [1] }, validacao: [0, 0, 2, 2] }, estado)
    assert.equal(p1.resultado.parouEm, 'M2')
    assert.deepEqual(p1.resultado.retomar.bugsCorrigidos, ['x/a.js bug 1.1'])
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), { caca: { M2: [1] }, cacaRepete: { M2: 1 } }, estado)
    assert.match(p2.prompt('caça: geral (M2, rodada 1)'), /Já corrigidos nesta missão [^\n]*\n1\. x\/a\.js bug 1\.1/)
    assert.match(p2.resultado.motivo, /confirmou de novo bug já corrigido/)
  })
})

describe('revisão: leitura do git', () => {
  test('lista resumida ou sem arquivos por commit é leitura inválida e se repete', async () => {
    const r = await rodar(plano(), { conferenciaResumida: 1, conferenciaSemPorCommit: 1 })
    assert.equal(r.resultado.concluido, true)
    assert.ok(r.logs.filter(l => /saída de \.claude\/missao\/git-estado\.mjs inválida/.test(l)).length >= 2)
  })

  test('com maxRetentativasInfra 0 a leitura do git ainda se repete, e a parada mostra o erro do script', async () => {
    const r = await rodar(plano({ maxRetentativasInfra: 0 }), { conferenciaErro: 'fatal: bad revision HEAD^{commit}' })
    assert.equal(r.resultado.parouEm, 'preparo')
    assert.equal(r.contar('preparo'), 2)
    assert.match(r.resultado.motivo, /não foi possível ler o git no preparo; última saída de .*: fatal: bad revision/)
  })
})

describe('revisão: contexto nas etapas de caça e aceite', () => {
  test('caçador, verificador, caça final e aceite recebem a técnica da etapa e as áreas pertinentes', async () => {
    const areas = [{ nome: 'Área X', guia: 'copie x/modelo.js', features: ['F1', 'F2', 'F3'] }]
    const r = await rodarCom({}, plano(), { areas, caca: { M1: [1] } })
    assert.equal(r.resultado.concluido, true)
    for (const [label, etapa] of [['caça: geral (M1, rodada 1)', 'caca-bug'], ['verificação 1: achado 1 (M1, rodada 1)', 'caca-bug'],
      ['caça: interação entre milestones (final, rodada 1)', 'caca-bug'], ['aceite', 'aceite']]) {
      assert.ok(r.prompt(label).includes(`Técnica da etapa ${etapa}`), label)
      assert.match(r.prompt(label), /### Área X\ncopie x\/modelo\.js/, label)
    }
  })
})

describe('revisão: bug só conta como corrigido depois da correção', () => {
  test('correção de achado que não fecha não deixa o bug como corrigido no retomar', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { caca: { M1: [1] }, revisaoFeature: { 'correção 1.1 (M1)': [1, 1, 1, 1] } }, estado)
    assert.equal(p1.resultado.parouEm, 'M1')
    assert.match(p1.resultado.motivo, /não fechou após 3 rodadas/)
    assert.deepEqual(p1.resultado.retomar.bugsCorrigidos, [])
  })

  test('correção da caça final que não fecha também não registra o bug', async () => {
    const r = await rodar(plano(), { caca: { final: [1] }, revisaoFeature: { 'correção 1.1 (Suíte final)': [1, 1, 1, 1] } })
    assert.equal(r.resultado.parouEm, 'Suíte final')
    assert.deepEqual(r.resultado.retomar.bugsCorrigidos, [])
    assert.equal(r.resultado.retomar.cacaFinalFeita, false)
  })
})

describe('revisão: suíte final e commits de fora', () => {
  test('a suíte recebe os commits de fora aceitos e o pedido de não corrigir o código deles', async () => {
    const r = await rodar(plano(), { commitDeFora: { F2: 'fora0001' }, foraImpacta: false })
    assert.equal(r.resultado.concluido, true)
    assert.match(r.prompt('suíte completa'), /Os commits fora0001 são de fora da missão: não peça correção do código deles/)
    const sem = await rodar(plano())
    assert.doesNotMatch(sem.prompt('suíte completa'), /são de fora da missão/)
  })
})

describe('aprendizados do projeto embutidos', () => {
  const comAprendizados = (texto, args, opcoes) =>
    executar(gerar(readFileSync(NUCLEO, 'utf8'), {}, '', lerEtapas(), texto).replace('export const meta', 'const meta'), args, opcoes)
  const comJornada = () => ({
    milestones: [
      { titulo: 'M1', criterio: 'c', userTesting: 'abre e salva', features: [{ titulo: 'F1', spec: 's' }] },
      { titulo: 'M2', criterio: 'c', features: [{ titulo: 'F2', spec: 's' }] },
    ],
  })

  test('vão em todo prompt de worker, antes dos aprendizados da execução', async () => {
    const r = await comAprendizados('- Rode os testes com forks=1.', comJornada(), {
      caca: { M1: [1] }, aprendizados: { F1: ['o serviço X devolve 404 sem acesso'] },
    })
    assert.equal(r.resultado.concluido, true)
    for (const label of ['pré-voo', 'contrato: M1', 'F1', 'revisão: F1', 'revisão: M1', 'testes: M1', 'caça: geral (M1, rodada 1)',
      'verificação 1: achado 1 (M1, rodada 1)', 'correção 1.1 (M1)', 'user testing: M1', 'suíte completa', 'aceite']) {
      assert.match(r.prompt(label), /Aprendizados do projeto:\n- Rode os testes com forks=1\./, label)
    }
    const p = r.prompt('F2')
    assert.ok(p.indexOf('Aprendizados do projeto:') < p.indexOf('Aprendizados desta missão:'))
    assert.doesNotMatch(r.prompt('commit: F1'), /Aprendizados do projeto/)
  })

  test('sem aprendizados.md, nenhuma seção', async () => {
    const r = await comAprendizados('', plano())
    assert.doesNotMatch(r.prompt('F1'), /Aprendizados do projeto/)
  })
})

describe('filtro de aprendizados da execução', () => {
  const comAprendizados = (texto, args, opcoes) =>
    executar(gerar(readFileSync(NUCLEO, 'utf8'), {}, '', lerEtapas(), texto).replace('export const meta', 'const meta'), args, opcoes)

  test('no máximo 3 por agente, sem duplicados e sem o que já está no aprendizados.md embutido', async () => {
    const r = await comAprendizados('- Rode os testes com forks=1.\n- Docker precisa estar vivo.', plano(), {
      aprendizados: {
        F1: ['a1', 'a2', 'rode os testes com forks=1', 'a4 descartado pelo limite'],
        F2: ['a1', 'A2.', 'b1'],
      },
    })
    assert.equal(r.resultado.concluido, true)
    // F1: só os 3 primeiros contam, e o terceiro já está no projeto. F2: a1 e A2. repetem.
    assert.deepEqual(r.resultado.aprendizados, ['a1', 'a2', 'b1'])
    assert.equal(r.resultado.sugestaoAprendizados, '- a1\n- a2\n- b1\n')
    assert.ok(r.logs.includes('1 aprendizado(s) acima do limite de 3 por agente descartado(s)'))
  })

  test('sem aprendizados, sem sugestão', async () => {
    const r = await rodar(plano())
    assert.equal(r.resultado.sugestaoAprendizados, null)
  })
})

describe('repete só vale apontando item existente da lista de corrigidos', () => {
  const comEtapas = () => ({ milestones: [{ titulo: 'M1', criterio: 'c', caca: ['geral'], features: [{ titulo: 'F1', spec: 's' }] }] })

  test('repete com a lista de corrigidos vazia vira correção, como bug novo', async () => {
    const r = await rodar(comEtapas(), { caca: { M1: [1] }, cacaRepete: { M1: 1 } })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('commit: correção 1.1 (M1)'), 1)
    assert.ok(r.logs.some(l => /marcado como repetido sem item válido .*tratado como bug novo: x\/a\.js bug 1\.1/.test(l)))
  })

  test('repete sem apontar item, ou apontando item que não existe, também vira correção', async () => {
    for (const cacaRepeteItem of [null, 5]) {
      const r = await rodar(comEtapas(), { caca: { M1: [1, 1] }, cacaRepete: { M1: 2 }, cacaRepeteItem })
      assert.equal(r.resultado.concluido, true, String(cacaRepeteItem))
      assert.equal(r.contar('commit: correção 2.1 (M1)'), 1, String(cacaRepeteItem))
    }
  })

  test('repete apontando item existente para a missão, com o bug repetido no motivo', async () => {
    const r = await rodar(comEtapas(), { caca: { M1: [1, 1] }, cacaRepete: { M1: 2 }, cacaRepeteItem: 1 })
    assert.equal(r.resultado.parouEm, 'M1')
    assert.match(r.resultado.motivo, /confirmou de novo bug já corrigido/)
    assert.equal(r.resultado.problemas[0].repetido, 'x/a.js bug 1.1')
    assert.match(r.prompt('caça: geral (M1, rodada 2)'), /o número dele\):\n1\. x\/a\.js bug 1\.1/)
  })
})

describe('aprendizados nas paradas e na retomada', () => {
  const embutido = (texto, args, opcoes, estado) =>
    executar(gerar(readFileSync(NUCLEO, 'utf8'), {}, '', lerEtapas(), texto).replace('export const meta', 'const meta'), args, opcoes, estado)

  test('paradas de simplicidade, planejar e pré-voo trazem a sugestão', async () => {
    const simp = await rodar({ spec: 's.md' }, { perguntas: ['p?'], aprendizados: { simplicidade: ['rode com forks=1'] } })
    assert.equal(simp.resultado.parouEm, 'simplicidade')
    assert.equal(simp.resultado.sugestaoAprendizados, '- rode com forks=1\n')
    const plan = await rodar({ spec: 's.md' }, { planoGerado: [{ titulo: 'Suíte final', criterio: 'c', features: [{ titulo: 'H', spec: 's' }] }], aprendizados: { planejar: ['x'] } })
    assert.equal(plan.resultado.parouEm, 'planejar')
    assert.equal(plan.resultado.sugestaoAprendizados, '- x\n')
    const voo = await rodar(plano(), { preVooFalta: ['Docker'], aprendizados: { 'pré-voo': ['docker info antes'] } })
    assert.equal(voo.resultado.parouEm, 'pré-voo')
    assert.equal(voo.resultado.sugestaoAprendizados, '- docker info antes\n')
  })

  test('aprendizados do retomar já embutidos no projeto não voltam nem entram na sugestão', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await embutido('', plano(), { aprendizados: { F1: ['rode com forks=1', 'b1'] }, validacao: [2, 2] }, estado)
    assert.deepEqual(p1.resultado.retomar.contexto.aprendizados, ['rode com forks=1', 'b1'])
    const p2 = await embutido('- Rode com forks=1.', plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.deepEqual(p2.resultado.aprendizados, ['b1'])
    assert.equal(p2.resultado.sugestaoAprendizados, '- b1\n')
  })
})

describe('modo enxugar', () => {
  const COMPLEMENTOS = [
    ['simplicidade', 'verificar-simplicidade'], ['planejar', 'planejar'], ['pré-voo', 'pre-voo'], ['contrato: M1', 'prova-de-contrato'],
    ['F1', 'implementar'], ['caça: geral (M1, rodada 1)', 'caca-bug'], ['verificação 1: achado 1 (M1, rodada 1)', 'caca-bug'],
    ['aceite', 'aceite'], ['revisão: F1', 'revisar'], ['revisão: M1', 'scrutiny'], ['testes: M1', 'scrutiny'],
    ['correção 1.1 (M1)', 'corrigir'],
  ]
  const primeiraLinha = nome => readFileSync(new URL(`../etapas/${nome}.enxugar.md`, import.meta.url), 'utf8').split('\n')[0]

  test('com modo enxugar, cada etapa com complemento o recebe; o aceite devolve a medição antes x depois', async () => {
    const r = await rodarCom({}, { spec: 'docs/enxugar.md', modo: 'enxugar' }, { caca: { M1: [1] } })
    assert.equal(r.resultado.concluido, true)
    for (const [label, etapa] of COMPLEMENTOS) {
      assert.ok(r.prompt(label).includes(`Modo enxugar (código existente):\n${primeiraLinha(etapa)}`), label)
    }
    assert.match(r.prompt('pré-voo'), /devolva em medicao/)
    assert.match(r.prompt('aceite'), /Meça do mesmo jeito que no início: \{"linhas":23000/)
    assert.equal(r.resultado.modo, 'enxugar')
    assert.deepEqual(r.resultado.medicao, { antes: MEDICAO_ANTES, depois: MEDICAO_DEPOIS })
  })

  test('sem o modo, nenhum complemento nem medição', async () => {
    const r = await rodarCom({}, { spec: 'docs/spec.md' }, { caca: { M1: [1] } })
    assert.equal(r.resultado.concluido, true)
    for (const [label] of COMPLEMENTOS) assert.doesNotMatch(r.prompt(label), /Modo enxugar/, label)
    assert.doesNotMatch(r.prompt('pré-voo'), /devolva em medicao/)
    assert.equal(r.resultado.medicao, undefined)
  })

  test('o marcador na SPEC em texto liga o modo; a retomada preserva modo e medição inicial', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodarCom({}, { spec: '<!-- modo: enxugar -->\n# Enxugar o Financial' }, { suite: [2, 2] }, estado)
    assert.equal(p1.resultado.parouEm, 'Suíte final')
    assert.equal(p1.resultado.retomar.modo, 'enxugar')
    assert.deepEqual(p1.resultado.retomar.medicaoAntes, MEDICAO_ANTES)
    const p2 = await rodarCom({}, { spec: 'x', retomar: p1.resultado.retomar }, {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.doesNotMatch(p2.prompt('pré-voo'), /devolva em medicao/)
    assert.deepEqual(p2.resultado.medicao, { antes: MEDICAO_ANTES, depois: MEDICAO_DEPOIS })
  })

  test('modo desconhecido é recusado', async () => {
    await assert.rejects(rodar(plano({ modo: 'outro' })), /args inválido/)
  })
})

describe('modo enxugar: correção não restaura o que saiu', () => {
  test('a frase fixa da correção muda só no modo enxugar', async () => {
    const enx = await rodarCom({}, { spec: 's.md', modo: 'enxugar' }, { caca: { M1: [1] } })
    assert.match(enx.prompt('correção 1.1 (M1)'), /não restaure código nem teste que saiu de propósito/)
    assert.doesNotMatch(enx.prompt('correção 1.1 (M1)'), /Corrija a causa: não desative/)
    const normal = await rodarCom({}, { spec: 's.md' }, { caca: { M1: [1] } })
    assert.match(normal.prompt('correção 1.1 (M1)'), /Corrija a causa: não desative, pule nem enfraqueça testes/)
  })
})

describe('modo enxugar: medição inicial e validação do modo', () => {
  test('o schema do pré-voo exige medicao só no modo enxugar', async () => {
    const enx = await rodarCom({}, { spec: 's.md', modo: 'enxugar' })
    assert.ok(enx.chamadas.find(c => c.label === 'pré-voo').schema.required.includes('medicao'))
    const normal = await rodar(plano())
    assert.ok(!normal.chamadas.find(c => c.label === 'pré-voo').schema.required.includes('medicao'))
  })

  test('sem medição no pré-voo, o antes x depois sai marcado como parcial', async () => {
    const r = await rodarCom({}, { spec: 's.md', modo: 'enxugar' }, { semMedicao: true })
    assert.equal(r.resultado.concluido, true)
    assert.deepEqual(r.resultado.medicao, { antes: null, depois: MEDICAO_DEPOIS, antesParcial: true })
  })

  test('medição inicial tirada na retomada vai marcada como parcial', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodarCom({}, plano({ modo: 'enxugar' }), { semMedicao: true, suite: [2, 2] }, estado)
    assert.equal(p1.resultado.retomar.antesParcial, true)
    const r = { ...p1.resultado.retomar, medicaoAntes: null, antesParcial: false }
    const p2 = await rodarCom({}, plano({ retomar: r }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.deepEqual(p2.resultado.medicao, { antes: MEDICAO_ANTES, depois: MEDICAO_DEPOIS, antesParcial: true })
  })

  test('retomar.modo inválido é recusado como args.modo', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { validacao: [2, 2] }, estado)
    await assert.rejects(rodar(plano({ retomar: { ...p1.resultado.retomar, modo: 'outro' } }), {}, estado), /args inválido/)
    await assert.rejects(rodar(plano({ modo: null })), /args inválido/)
  })
})

describe('UI/UX por milestone', () => {
  const comTela = extra => ({
    ...extra,
    milestones: [
      { titulo: 'M1', criterio: 'c', ui: 'diálogo de transferência', userTesting: 'transfere entre contas', features: [{ titulo: 'F1', spec: 's' }] },
      { titulo: 'M2', criterio: 'c', features: [{ titulo: 'F2', spec: 's' }] },
    ],
  })

  test('roda só em milestone com tela, depois do contrato e antes de implementar', async () => {
    const r = await rodarCom({}, comTela())
    assert.equal(r.resultado.concluido, true)
    const ordem = r.chamadas.map(c => c.label)
    assert.ok(ordem.indexOf('contrato: M1') < ordem.indexOf('design: M1'))
    assert.ok(ordem.indexOf('design: M1') < ordem.indexOf('F1'))
    // M1 traz ui no plano: sem detecção. M2 não traz: o agente barato detecta e não acha tela.
    assert.equal(r.contar('telas: M1'), 0)
    assert.equal(r.chamadas.find(c => c.label === 'telas: M2').model, 'haiku')
    assert.equal(r.contar('design: M2'), 0)
    assert.match(r.prompt('design: M1'), /diálogo de transferência/)
    assert.match(r.prompt('design: M1'), /skill \/design, a skill impeccable ou a ferramenta Artifact de design/)
    assert.match(r.prompt('design: M1'), /Não espere aprovação de ninguém/)
    assert.ok(r.prompt('design: M1').includes('Técnica da etapa ui-ux'))
    assert.match(r.logs.find(l => l.startsWith('Estimativa')), new RegExp(`${r.agentes} agentes`))
  })

  test('implementar, revisar e user testing recebem o desenho; o resto do milestone sem tela não', async () => {
    const r = await rodarCom({}, comTela(), { userTesting: { M1: [1, 0] } })
    assert.equal(r.resultado.concluido, true)
    for (const label of ['F1', 'revisão: F1', 'user testing: M1', 'correção 1.1 (M1)']) {
      assert.match(r.prompt(label), /Desenho de UI\/UX do milestone[^\n]*\ndesenho de M1: seletor pesquisável de conta/, label)
      assert.match(r.prompt(label), /Nunca peça ID, UUID ou código técnico digitado/, label)
    }
    assert.match(r.prompt('revisão: F1'), /pedir ID ou UUID digitado à mão.*é bloqueante/)
    assert.doesNotMatch(r.prompt('F2'), /Desenho de UI\/UX/)
  })

  test('resultado traz designs com links, texto e os desvios do user testing', async () => {
    const r = await rodarCom({}, comTela(), { userTesting: { M1: [1, 0] }, designLinks: ['https://claude.ai/design/x'] })
    assert.deepEqual(r.resultado.designs, [{
      milestone: 'M1', links: ['https://claude.ai/design/x'], texto: 'desenho de M1: seletor pesquisável de conta', desvios: ['u0'],
    }])
  })

  test('agente de UI/UX que cai não para a missão', async () => {
    const r = await rodar(comTela({ maxRetentativasInfra: 0 }), { quedas: { 'design: M1': 1 } })
    assert.equal(r.resultado.concluido, true)
    assert.deepEqual(r.resultado.designs, [])
    assert.ok(r.logs.some(l => /M1: o agente de UI\/UX não respondeu; a missão segue sem desenho/.test(l)))
  })

  test('retomar preserva o desenho e não redesenha', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(comTela(), { validacao: [2, 2] }, estado)
    assert.equal(p1.resultado.parouEm, 'M1')
    assert.equal(p1.resultado.retomar.designs.M1.texto, 'desenho de M1: seletor pesquisável de conta')
    const p2 = await rodar(comTela({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.equal(p2.contar('design: M1'), 0)
    assert.equal(p2.contar('telas: M2'), 1)
    assert.equal(p2.resultado.designs[0].milestone, 'M1')
  })

  test('detecção barata acha tela e o milestone ganha desenho; modo enxugar recebe o complemento', async () => {
    const r = await rodarCom({}, { spec: 's.md', modo: 'enxugar' }, { ui: { M1: 'tela de contas' } })
    assert.equal(r.contar('design: M1'), 1)
    assert.match(r.prompt('design: M1'), /tela de contas/)
    assert.match(r.prompt('design: M1'), /Modo enxugar \(código existente\):\nModo enxugar: desenhe só as telas que mudam/)
    const normal = await rodarCom({}, { spec: 's.md' }, { ui: { M1: 'tela de contas' } })
    assert.doesNotMatch(normal.prompt('design: M1'), /Modo enxugar/)
  })
})
