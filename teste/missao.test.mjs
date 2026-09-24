import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { executar, carregar, plano, DUMP } from './simulador.mjs'
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
    assert.equal(r.agentes, 2 + 4 * 3 + 4 * 2 + 3)
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
      assert.match(r.chamadas[i + 1].prompt, new RegExp(`rev-list --reverse ${antes}\\.\\.HEAD`), feature)
    }
    assert.notEqual(f1, f2)
  })

  test('commit de fora antes do commit da feature: para com o sha, e o retomar ajustado segue', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { commitDeFora: { F2: 'fora0001' } }, estado)
    assert.equal(p1.resultado.parouEm, 'M1')
    assert.match(p1.resultado.motivo, /commit de fora da missão logo depois da feature "F2": fora0001\./)
    assert.match(p1.resultado.motivo, /git rev-list --reverse <retomar\.base>\.\.HEAD/)
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
