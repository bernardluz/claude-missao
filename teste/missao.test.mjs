import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { executar, carregar, plano, MEDICAO_ANTES, MEDICAO_DEPOIS } from './simulador.mjs'
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
    assert.equal(r.agentes, 3 + 5 * 3 + 8 * 2 + 5)
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
    assert.match(r.prompt('F2 · ajuste 1'), /o commit falhou \(gate ou hook\): saida=1\nlint falhou/)
  })

  test('feature original já resolvida no código conta como concluída sem commit, vira decisão assumida e segue', async () => {
    const r = await rodar(plano(), { jaResolvidoFeature: { F1: true }, evidencias: [[{ feature: 'F1', evidencia: 'teste/f1.test.mjs:10' }]] })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.commits, 2)
    assert.match(r.prompt('testes: M1'), /Estas features saíram sem commit, como já resolvidas no código\. .*\n- F1: /)
    assert.doesNotMatch(r.prompt('testes: M2'), /Estas features saíram sem commit/)
    assert.equal(r.contar('revisão: F1'), 0)
    assert.equal(r.contar('commit: F1'), 0)
    assert.deepEqual(r.resultado.decisoesAssumidas, ['já resolvida no código (F1): o teste já existe'])
    const f1 = r.resultado.relatorio.flatMap(x => x.features ?? []).find(x => x.feature === 'F1')
    assert.equal(f1.jaResolvido, true)
    assert.equal(f1.semCommit, true)
  })

  test('feature já resolvida sem evidência no scrutiny vira problema e segue o loop de correção', async () => {
    const r = await rodar(plano(), { jaResolvidoFeature: { F1: true }, evidencias: [[], [{ feature: 'F1', evidencia: 'teste/f1.test.mjs:10' }]] })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('correção 1.1 (M1)'), 1)
    assert.match(r.prompt('correção 1.1 (M1)'), /a feature "F1" saiu como já resolvida no código, sem evidência \(teste ou arquivo:linha\)/)
    assert.equal(r.contar('testes: M1'), 2)
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
      // leitura antes do commit, o commit e a conferência depois dele, todas a partir do HEAD anterior
      assert.equal(ordem[i - 1], 'conferência', feature)
      assert.equal(ordem[i + 1], 'conferência', feature)
      for (const j of [i - 1, i + 1]) assert.match(r.chamadas[j].prompt, new RegExp(`node \\.claude/missao/git-estado\\.mjs ${antes}\``), feature)
    }
    assert.notEqual(f1, f2)
  })

  test('commit de fora que não toca a missão: aceito sem agente juiz, entra nos commits esperados e a missão segue', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const r = await rodar(plano(), { commitDeFora: { F2: 'fora0001', 'testes: M2': 'fora0002' } }, estado)
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('commit de fora'), 0)
    assert.ok(r.logs.some(l => l.startsWith('commit de fora aceito, não toca a missão: fora0001')))
    assert.ok(r.logs.some(l => l.startsWith('commit de fora aceito, não toca a missão: fora0002')))
    assert.equal(r.resultado.head, estado.git.at(-1))
    assert.match(r.resultado.relatorio[1].commits, new RegExp(`\.\.${estado.git.at(-1)}$`))
    assert.deepEqual(r.resultado.deForaTocando, [])
  })

  test('commit de fora depois do commit da feature: aceito e a missão segue', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const r = await rodar(plano(), { commitDeFora: { 'commit: F1': 'fora0001' } }, estado)
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('F2'), 1)
    assert.equal(r.resultado.head, estado.git.at(-1))
  })

  test('commit de fora durante a validação: a conferência do milestone aceita e a missão segue', async () => {
    const r = await rodar(plano(), { commitDeFora: { 'testes: M1': 'fora0002' } })
    assert.equal(r.resultado.concluido, true)
    assert.ok(r.logs.some(l => l.startsWith('commit de fora aceito, não toca a missão: fora0002')))
  })

  test('commit de fora que toca arquivo da missão: aceito, registrado e revisado no scrutiny e na caça', async () => {
    // F2 mexe só em y/c.js; o commit de fora, no meio dela, toca x/a.js, que F1 já commitou.
    const r = await rodar(plano(), { commitDeFora: { F2: 'fora0001' }, arquivosDeFora: ['x/a.js'], arquivosDaFeature: { F2: ['y/c.js'] } })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('commit de fora'), 0)
    assert.ok(r.logs.some(l => /^commit de fora aceito, toca a missão: fora0001\. .*x\/a\.js/.test(l)))
    assert.deepEqual(r.resultado.deForaTocando, [{ milestone: 'M1', commits: ['fora0001'], arquivos: ['x/a.js'] }])
    const revise = /Arquivos da missão tocados por commit de fora: x\/a\.js \(fora0001\)\. Revise-os/
    for (const label of ['revisão: M1', 'testes: M1', 'caça: geral (M1, rodada 1)', 'caça: interação entre milestones (final, rodada 1)', 'suíte completa']) {
      assert.match(r.prompt(label), revise, label)
    }
    // Só o milestone em que o commit de fora apareceu revisa esses arquivos; o fim da missão revisa todos.
    assert.doesNotMatch(r.prompt('revisão: M2'), revise)
  })

  test('commit que leva o diff da feature, só com arquivos da lista, é da feature e nunca de fora', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const r = await rodar(plano(), { commitDeForaTudo: { 'revisão: F1': 'fora0001' }, arquivosDeFora: ['x/a.js'] }, estado)
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.resultado.relatorio[0].features[0].commit, 'fora0001')
    assert.equal(r.contar('commit: F1'), 0)
    assert.deepEqual(r.resultado.deForaTocando, [])
    assert.ok(!r.resultado.retomar?.deFora?.includes('fora0001'))
    assert.equal(r.commits, 3)
  })

  test('diff da feature sumiu sem ir para commit nenhum: o commit de fora é aceito e a missão para pela feature', async () => {
    const r = await rodar(plano(), { commitDeForaTudo: { 'revisão: F1': 'fora0001' } })
    assert.equal(r.resultado.parouEm, 'M1')
    assert.match(r.resultado.motivo, /o diff da feature não foi commitado \(nenhum arquivo da lista com mudança pendente\)/)
    assert.ok(r.logs.some(l => l.startsWith('commit de fora aceito, não toca a missão: fora0001')))
    assert.deepEqual(r.resultado.retomar.deFora, ['fora0001'])
  })

  test('agente que não commita, com commit de fora que não levou o diff: aceita o de fora e repete o commit', async () => {
    const r = await rodar(plano(), { commitDeFora: { 'revisão: F1': 'fora0001' }, falhaCommit: { F1: 'index.lock existe' } })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('commit: F1'), 2)
    assert.ok(r.logs.some(l => l.startsWith('commit de fora aceito, não toca a missão: fora0001')))
    assert.ok(r.logs.some(l => /^F1: arquivos da lista ainda sem commit \(x\/a\.js\); repetindo o commit$/.test(l)))
  })

  test('queda do agente de commit com commit de fora no intervalo: aceita o de fora e repete o commit', async () => {
    const r = await rodar(plano(), { quedas: { 'commit: F1': 1 }, efeitoDaQueda: { 'commit: F1': 'commitaFora' } })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('commit: F1'), 2)
    assert.ok(r.resultado.retomar === undefined)
    assert.ok(r.logs.some(l => l.startsWith('commit de fora aceito, não toca a missão: fora0009')))
  })

  test('SHA declarado que não está no git não entra no retomar', async () => {
    const r = await rodar(plano(), { shaErrado: { F1: 'abcdef1' } })
    assert.match(r.resultado.motivo, /declarou abcdef1, mas base0000\.\.HEAD tem sha00001/)
    assert.deepEqual(r.resultado.retomar.concluidas, [])
    assert.deepEqual(r.resultado.retomar.commits, [])
  })

  test('arquivo alterado e não declarado vira ajuste antes do commit; declarado, vai no commit', async () => {
    const r = await rodar(plano(), { arquivosGit: ['x/a.js', 'y/b.js'], arquivosAjuste: ['x/a.js', 'y/b.js'] })
    assert.equal(r.resultado.concluido, true)
    assert.match(r.prompt('F1 · ajuste 1'), /mudanças novas na árvore fora da lista da feature: y\/b\.js\. Se forem desta feature \(inclusive a origem de uma renomeação\), declare-as/)
    assert.match(r.prompt('commit: F1'), /git add -- 'x\/a\.js' 'y\/b\.js'/)
    // Não declarado e não desfeito: a revisão não fecha e nada é commitado.
    const teimoso = await rodar(plano(), { arquivosGit: ['x/a.js', 'y/b.js'] })
    assert.match(teimoso.resultado.motivo, /não fechou após 3 rodadas de ajuste: mudanças novas na árvore fora da lista/)
    assert.equal(teimoso.contar('commit: F1'), 0)
  })

  test('renomeação declarada só pelo destino vira ajuste; com origem e destino, o commit leva os dois', async () => {
    const r = await rodar(plano(), { arquivos: ['x/novo.js'], arquivosGit: ['x/velho.js -> x/novo.js'], arquivosAjuste: ['x/velho.js', 'x/novo.js'] })
    assert.equal(r.resultado.concluido, true)
    assert.match(r.prompt('F1 · ajuste 1'), /fora da lista da feature: x\/velho\.js\./)
    assert.match(r.prompt('commit: F1'), /git add -- 'x\/novo\.js' 'x\/velho\.js'|git add -- 'x\/velho\.js' 'x\/novo\.js'/)
  })

  test('commit que o próprio worker fez, com arquivo fora da lista, fica fora do retomar até o usuário decidir', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const opcoes = { arquivosGit: ['x/a.js', 'y/b.js'], workerCommita: { F1: true } }
    const p1 = await rodar(plano(), opcoes, estado)
    assert.match(p1.resultado.motivo, /commit de "F1", sha00001, tem arquivos fora da lista revisada: y\/b\.js\. Ele ficou fora do retomar/)
    assert.equal(p1.contar('commit: F1'), 0)
    const retomar = p1.resultado.retomar
    assert.deepEqual(retomar.concluidas, [])
    assert.deepEqual(retomar.commits, [])
    const aceito = { ...retomar, commits: estado.git.slice(1), head: estado.git.at(-1), concluidas: ['F1'] }
    const p2 = await rodar(plano({ retomar: aceito }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.equal(p2.contar('F1'), 0)
  })

  test('commit que o próprio worker fez, só com arquivos da lista, é conferido como da feature', async () => {
    const r = await rodar(plano(), { workerCommita: { F1: true } })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('commit: F1'), 0)
    assert.equal(r.resultado.relatorio[0].features[0].commit, 'sha00001')
    assert.deepEqual(r.resultado.deForaTocando, [])
    assert.match(r.prompt('revisão: F1'), /git diff base0000 -- <esses caminhos>/)
  })

  test('pasta nova declarada como no git status cobre os arquivos de dentro', async () => {
    const pasta = { arquivos: ['novo/'], arquivosGit: ['novo/a.js', 'novo/b.js'] }
    assert.equal((await rodar(plano(), pasta)).resultado.concluido, true)
    const adotado = await rodar(plano(), { ...pasta, quedas: { 'commit: F1': 1 }, efeitoDaQueda: { 'commit: F1': 'commita' } })
    assert.equal(adotado.resultado.concluido, true)
    assert.equal(adotado.contar('commit: F1'), 1)
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

  test('leitura do git que não volta ou branch trocada antes do commit param a missão', async () => {
    const semLeitura = await rodar(plano(), { quedas: { conferência: 3 } })
    assert.match(semLeitura.resultado.motivo, /não foi possível ler o repositório antes do commit/)
    assert.deepEqual(semLeitura.resultado.retomar.arquivosPendentes, ['x/a.js'])
    const outraBranch = await rodar(plano(), { branchNaConferencia: 'outra' })
    assert.match(outraBranch.resultado.motivo, /branch mudou para "outra" antes do commit de "F1"/)
  })

})

describe('agente de commit', () => {
  test('recusa do harness para a missão, sem virar ajuste', async () => {
    const r = await rodar(plano(), { recusa: { F1: { motivo: 'Credential Leakage' } } })
    assert.equal(r.resultado.parouEm, 'M1')
    assert.match(r.resultado.motivo, /recusou o comando de commit, e a missão não contorna recusa: Credential Leakage\./)
    assert.match(r.resultado.motivo, /ficou sem commit/)
    assert.equal(r.contar('F1 · ajuste'), 0)
    assert.equal(r.contar('commit: F1'), 1)
    assert.equal(r.commits, 0)
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

  test('agente de commit só roda o comando pronto, e o worker nunca commita', async () => {
    const r = await rodar(plano())
    const p = r.prompt('commit: F1')
    assert.match(p, /Rode exatamente o comando abaixo, uma vez/)
    assert.match(p, /recusar o comando, não tente de outro jeito: devolva recusado=true/)
    assert.equal(r.chamadas.find(c => c.label === 'commit: F1').model, 'haiku')
    assert.match(r.prompt('F1'), /Não rode `git commit`, `git add`, `git stash`, `git reset` nem `git checkout -- \.`: quem commita é a missão/)
  })

  test('prompts que rodam build, testes ou gates mandam a saída para arquivo, nunca por pipe', async () => {
    const r = await rodar(plano(), { revisaoFeature: { F1: [1, 0] } })
    for (const label of ['F1', 'F1 · ajuste 1', 'revisão: F1', 'revisão: M1', 'testes: M1', 'suíte completa']) {
      assert.match(r.prompt(label), /<comando> > "\$log" 2>&1; echo "saida=\$\?"; tail -40 "\$log"/, label)
      assert.match(r.prompt(label), /Nunca leia a saída por pipe \(`\| tail`, `\| head`, `\| tee`\): um daemon/, label)
    }
    assert.match(r.prompt('commit: F1'), /git add -- 'x\/a\.js' > "\$log" 2>&1 && git commit -F "\$msg" -- 'x\/a\.js' >> "\$log" 2>&1; echo "saida=\$\?"; tail -60 "\$log"/)
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

  test('worker cai com commit novo no intervalo: não para, repete e a conferência classifica o commit', async () => {
    const r = await rodar(plano(), { quedas: { F2: 1 }, efeitoDaQueda: { F2: 'commitaOrfao' } })
    assert.equal(r.resultado.concluido, true)
    assert.ok(r.logs.some(l => /^F2: agente caiu com commit\(s\) novo\(s\) no intervalo \(orfao000\); repetindo/.test(l)))
    assert.ok(r.logs.some(l => l.startsWith('commit de fora aceito, não toca a missão: orfao000')))
    assert.equal(r.contar('F2'), 2 + r.contar('F2 ·'))
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

  test('commit alheio entre a parada e a retomada é aceito como de fora e a missão segue', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { validacao: [2, 2] }, estado)
    estado.git.push('alheio00')
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.ok(p2.logs.some(l => l.startsWith('commit de fora aceito, não toca a missão: alheio00')))
    assert.equal(p2.contar('F1') + p2.contar('F2'), 0)
  })

  test('retomada recusa quando o histórico da missão foi reescrito', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { validacao: [2, 2] }, estado)
    estado.git.splice(1, 1, 'reescrit')
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
    assert.match(r.prompt('F1'), /PROJ_SKIP_\*/)
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

  test('args.config ajusta textos numa execução; a mensagem do worker vai no commit', async () => {
    const r = await rodarCom(CONFIG_EXEMPLO, plano({ config: { formatoCommit: 'feat(x): y', idioma: 'en' } }), { mensagem: { F1: 'feat(x): adiciona a' } })
    assert.match(r.prompt('F1'), /mensagem do commit da feature, feat\(x\): y em en\./)
    assert.match(r.prompt('F1'), /PROJ_SKIP_\*/)
    assert.match(r.prompt('commit: F1'), /<<'MSG_MISSAO'\nfeat\(x\): adiciona a\nMSG_MISSAO/)
    assert.match(r.prompt('commit: F2'), /<<'MSG_MISSAO'\nfeat: F2\nMSG_MISSAO/)
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

  test('simplicidade: só item bloqueante para a missão, sem código, e devolve também as decisões assumidas', async () => {
    const simplicidade = [
      { tipo: 'pergunta', texto: 'o limite de saque muda?', classe: 'bloqueante', sugestao: 'manter', motivo: 'dinheiro' },
      { tipo: 'corte', texto: 'tabela de histórico sem uso', classe: 'decidido', sugestao: 'tirar a tabela' },
      { tipo: 'pergunta', texto: 'qual índice?', classe: 'decidido', sugestao: '' },
    ]
    const r = await rodar(comSpec(), { simplicidade })
    assert.equal(r.resultado.parouEm, 'simplicidade')
    assert.match(r.resultado.motivo, /2 decisão\(ões\) de produto ou de risco .*nenhum código foi escrito/)
    // Decidido sem sugestão não tem como seguir: vira bloqueante.
    assert.deepEqual(r.resultado.bloqueantes.map(b => b.texto), ['o limite de saque muda?', 'qual índice?'])
    assert.deepEqual(r.resultado.decisoesAssumidas, ['corte: tabela de histórico sem uso → tirar a tabela'])
    assert.equal(r.contar('planejar'), 0)
    assert.equal(r.commits, 0)
    assert.match(r.prompt('simplicidade'), /SPEC \(texto, ou caminho de arquivo no repositório para ler inteiro\):\ndocs\/spec\.md/)
    assert.match(r.prompt('simplicidade'), /bloqueante: decisão de produto ou de risco \(dinheiro, acesso, dado sensível\)/)
    assert.match(r.prompt('simplicidade'), /corte que remove algo que a SPEC pede explicitamente/)
    assert.match(r.prompt('simplicidade'), /Na dúvida, item que envolve dinheiro, acesso ou autorização, ou dado sensível é bloqueante; os demais, com sugestão segura, são decididos/)
    assert.doesNotMatch(r.prompt('simplicidade'), /Na dúvida entre as duas, e com sugestão segura, decidido/)
  })

  test('simplicidade só com itens decididos não para: as decisões vão ao planejador, ao resultado e ao retomar', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const simplicidade = [
      { tipo: 'pergunta', texto: 'enum ou texto no status?', classe: 'decidido', sugestao: 'enum' },
      { tipo: 'corte', texto: 'fila de reprocessamento', classe: 'decidido', sugestao: 'chamada HTTP síncrona' },
    ]
    const decisoes = ['pergunta: enum ou texto no status? → enum', 'corte: fila de reprocessamento → chamada HTTP síncrona']
    const p1 = await rodar(comSpec(), { simplicidade, suite: [2, 2] }, estado)
    assert.equal(p1.contar('planejar'), 1)
    assert.match(p1.prompt('planejar'), /Decisões assumidas na verificação de simplicidade \(aplique no plano; corte sai do plano\):\n- pergunta: enum ou texto no status\? → enum\n- corte: fila de reprocessamento → chamada HTTP síncrona/)
    assert.equal(p1.resultado.parouEm, 'Suíte final')
    assert.deepEqual(p1.resultado.decisoesAssumidas, decisoes)
    assert.deepEqual(p1.resultado.retomar.decisoesAssumidas, decisoes)
    const p2 = await rodar(comSpec({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.deepEqual(p2.resultado.decisoesAssumidas, decisoes)
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
    const r = await rodar(comSpec(), { planoGerado: [{ titulo: 'G', criterio: 'c', features: [{ titulo: 'H', spec: 's' }, { titulo: 'H', spec: 's' }] }] })
    assert.equal(r.resultado.parouEm, 'planejar')
    assert.match(r.resultado.motivo, /plano gerado não serve: títulos de feature repetidos: H/)
    assert.equal(r.commits, 0)
  })

  test('título reservado no plano gerado é renomeado, sem parar', async () => {
    const r = await rodar(comSpec(), { planoGerado: [
      { titulo: 'Suíte final', criterio: 'c', features: [{ titulo: 'H', spec: 's' }] },
      { titulo: 'Milestone final', criterio: 'c', features: [{ titulo: 'H2', spec: 's' }] },
    ] })
    assert.equal(r.resultado.concluido, true)
    assert.deepEqual(r.resultado.plano.milestones.map(x => x.titulo), ['Milestone final 2', 'Milestone final'])
    assert.ok(r.logs.includes('plano gerado usou o título reservado "Suíte final": renomeado para "Milestone final 2"'))
    assert.match(r.prompt('planejar'), /Nunca use "Suíte final" como título de milestone/)
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

  test('aceite como texto vira lista de um item; tipo inválido é recusado', async () => {
    const r = await rodar(plano({ aceite: 'POST /x devolve 201' }))
    assert.equal(r.resultado.concluido, true)
    assert.match(r.prompt('aceite'), /Critérios de aceite:\n- POST \/x devolve 201/)
    await assert.rejects(rodar(plano({ aceite: 3 })), /args inválido/)
  })
})

describe('revisão: retomada e commits de fora', () => {
  test('na retomada, commit de fora que toca arquivo de milestone anterior é aceito e revisado no fim da missão', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { validacao: [0, 2, 2] }, estado)
    assert.equal(p1.resultado.parouEm, 'M2')
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {
      commitDeFora: { 'revisão: M2': 'fora0001' }, arquivosDeFora: ['x/a.js'],
    }, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.equal(p2.contar('commit de fora'), 0)
    assert.ok(p2.logs.some(l => /^commit de fora aceito, toca a missão: fora0001\. .*x\/a\.js/.test(l)))
    assert.match(p2.prompt('suíte completa'), /Arquivos da missão tocados por commit de fora: x\/a\.js \(fora0001\)\. Revise-os/)
    assert.match(p2.prompt('conferência'), /git-estado\.mjs base0000 --resumo sha\d{5}`/)
  })

  test('commit de fora que toca a missão vai no retomar e volta ao scrutiny do milestone na retomada', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { commitDeFora: { F3: 'fora0001' }, arquivosDeFora: ['x/a.js'], arquivosDaFeature: { F3: ['y/c.js'] }, validacao: [0, 2, 2] }, estado)
    assert.equal(p1.resultado.parouEm, 'M2')
    assert.deepEqual(p1.resultado.retomar.deForaTocando, [{ milestone: 'M2', commits: ['fora0001'], arquivos: ['x/a.js'] }])
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.match(p2.prompt('revisão: M2'), /Arquivos da missão tocados por commit de fora: x\/a\.js \(fora0001\)\. Revise-os/)
  })

  test('commit de fora aceito vai no retomar e não conta como arquivo da missão na retomada', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { commitDeFora: { F2: 'fora0001' }, arquivosDeFora: ['z/fora.js'], validacao: [0, 2, 2] }, estado)
    assert.equal(p1.resultado.parouEm, 'M2')
    assert.deepEqual(p1.resultado.retomar.deFora, ['fora0001'])
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {
      commitDeFora: { 'revisão: M2': 'fora0002' }, arquivosDeFora: ['z/fora.js'],
    }, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.ok(p2.logs.some(l => l.startsWith('commit de fora aceito, não toca a missão: fora0002')))
    // A retomada lê a missão no modo compacto do script, passando os commits de fora já aceitos.
    assert.match(p2.prompt('conferência'), /git-estado\.mjs base0000 --resumo sha\d{5} fora0001`/)
  })
})

describe('revisão: commit de fora aceito fica fora do escopo', () => {
  test('arquivos do commit de fora não entram no revisor por pasta, nas áreas de caça nem nas correções', async () => {
    const r = await rodarCom(CONFIG_EXEMPLO, plano(), {
      arquivos: ['services/a.kt'], commitDeFora: { F2: 'fora0001' }, arquivosDeFora: ['web/y.ts'],
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
    const r = await rodar(plano(), { commitDeFora: { F2: 'fora0001' } })
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
    const simp = await rodar({ spec: 's.md' }, { simplicidade: [{ tipo: 'pergunta', texto: 'p?', classe: 'bloqueante' }], aprendizados: { simplicidade: ['rode com forks=1'] } })
    assert.equal(simp.resultado.parouEm, 'simplicidade')
    assert.equal(simp.resultado.sugestaoAprendizados, '- rode com forks=1\n')
    const plan = await rodar({ spec: 's.md' }, { planoGerado: [{ titulo: 'G', criterio: 'c', features: [{ titulo: 'H', spec: 's' }, { titulo: 'H', spec: 's' }] }], aprendizados: { planejar: ['x'] } })
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

  test('resultado traz designs com links e texto; desvios resolvidos não ficam', async () => {
    const r = await rodarCom({}, comTela(), { userTesting: { M1: [1, 0] }, utUx: [[true]], designLinks: ['https://claude.ai/design/x'] })
    assert.deepEqual(r.resultado.designs, [{
      milestone: 'M1', links: ['https://claude.ai/design/x'], texto: 'desenho de M1: seletor pesquisável de conta', desvios: [],
    }])
  })

  test('desvios: só os de UX e só os da última rodada', async () => {
    const r = await rodarCom({}, comTela(), { userTesting: { M1: [2, 2] }, utUx: [[true, true], [false, true]] })
    assert.equal(r.resultado.parouEm, 'M1')
    assert.deepEqual(r.resultado.designs[0].desvios, ['u1'])
    assert.match(r.prompt('user testing: M1'), /cada desvio vira problema, com ux=true/)
  })

  test('revisão só cobra as telas desta feature, não o que outra feature ainda vai entregar', async () => {
    const r = await rodarCom({}, comTela())
    assert.match(r.prompt('revisão: F1'), /só das telas e fluxos que ESTA feature cria ou muda/)
    assert.match(r.prompt('revisão: F1'), /O que outra feature do milestone ainda vai entregar \(outra tela, um ponto de entrada em outra tela\) não é achado/)
    assert.match(r.prompt('revisão: F1'), /Feature sem tela não tem achado de UX/)
  })

  test('detecção de telas que cai não grava nada, para a retomada tentar de novo', async () => {
    const r = await rodar(plano({ maxRetentativasInfra: 0 }), { quedas: { 'telas: M1': 1 }, validacao: [2, 2] })
    assert.equal(r.resultado.parouEm, 'M1')
    assert.equal('M1' in r.resultado.retomar.designs, false)
    assert.ok(r.logs.some(l => /M1: o agente que detecta telas não respondeu/.test(l)))
  })

  test('no modo enxugar, o bloco do desenho leva o complemento ui-ux.enxugar', async () => {
    const r = await rodarCom({}, { spec: 's.md', modo: 'enxugar' }, { ui: { M1: 'tela de contas' } })
    assert.match(r.prompt('F1'), /Desenho de UI\/UX[\s\S]*Modo enxugar: desenhe só as telas que mudam/)
    const normal = await rodarCom({}, { spec: 's.md' }, { ui: { M1: 'tela de contas' } })
    assert.doesNotMatch(normal.prompt('F1'), /desenhe só as telas que mudam/)
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

describe('árvore suja não para a missão', () => {
  const comSujeira = () => ({ git: ['base0000'], sujo: false, alheios: [' M notas.txt', '?? rascunho/ideia.md'] })

  test('sujeira de antes da missão não para, vira linha de base e não entra em nenhum commit', async () => {
    const estado = comSujeira()
    const r = await rodar(plano(), {}, estado)
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.commits, 3)
    assert.deepEqual(estado.alheios, [' M notas.txt', '?? rascunho/ideia.md'])
    assert.ok(r.logs.some(l => /árvore com 2 mudança\(s\) não commitada\(s\) de antes: ficam fora dos commits \(notas\.txt, rascunho\/ideia\.md\)/.test(l)))
    assert.deepEqual(r.resultado.sujeiraCommitada, [])
  })

  test('agente de commit recebe só a lista do worker; a sujeira de antes não entra no comando', async () => {
    const r = await rodar(plano(), { arquivos: ['x/a.js', 'x/b.js'] }, comSujeira())
    const p = r.prompt('commit: F1')
    assert.match(p, /git add -- 'x\/a\.js' 'x\/b\.js' > "\$log" 2>&1 && git commit -F "\$msg" -- 'x\/a\.js' 'x\/b\.js'/)
    assert.doesNotMatch(p, /notas\.txt|rascunho/)
    assert.match(r.prompt('revisão: F1'), /O diff desta feature são os arquivos x\/a\.js, x\/b\.js.*Outras mudanças na árvore não são desta feature: ignore-as/)
  })

  test('arquivo sujo antes e editado pelo worker vai inteiro no commit e vira aviso, sem parar', async () => {
    const estado = { git: ['base0000'], sujo: false, alheios: [' M x/a.js', ' M notas.txt'] }
    const r = await rodar(plano(), {}, estado)
    assert.equal(r.resultado.concluido, true)
    assert.deepEqual(r.resultado.sujeiraCommitada, [{ feature: 'F1', commit: 'sha00001', arquivos: ['x/a.js'] }])
    assert.ok(r.logs.some(l => /^aviso: "F1" commitou inteiro arquivo que já tinha mudança antes da missão: x\/a\.js$/.test(l)))
    assert.deepEqual(estado.alheios, [' M notas.txt'])
  })

  test('sujeira alheia surgindo no meio da missão não para nem entra nos commits', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const r = await rodar(plano(), {
      suja: { 'commit: F1': 'outra/sessao.js', 'testes: M1': 'outra/depois.js', F3: 'outra/durante.js' },
      naoSao: { 'F3 · ajuste 1': ['outra/durante.js'] },
    }, estado)
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.commits, 3)
    // A que surge depois de um commit ou entre milestones fica registrada; a que surge durante o worker volta para ele,
    // que diz em naoSao que não é dele.
    assert.equal(r.contar('F1 · ajuste') + r.contar('F2 · ajuste'), 0)
    assert.match(r.prompt('F3 · ajuste 1'), /fora da lista da feature: outra\/durante\.js\..*liste-as em naoSao/)
    assert.deepEqual(estado.alheios.sort(), [' M outra/depois.js', ' M outra/durante.js', ' M outra/sessao.js'])
    for (const c of ['commit: F1', 'commit: F2', 'commit: F3']) assert.doesNotMatch(r.prompt(c), /outra\//, c)
  })

  test('linha de base vai no retomar e soma a sujeira da retomada', async () => {
    const estado = comSujeira()
    const p1 = await rodar(plano(), { validacao: [2, 2] }, estado)
    assert.deepEqual(p1.resultado.retomar.sujeiraInicial, ['notas.txt', 'rascunho/ideia.md'])
    estado.alheios.push(' M nova.txt')
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.ok(p2.logs.some(l => /árvore com 3 mudança\(s\) não commitada\(s\) de antes/.test(l)))
  })

  test('worker que cai com sujeira de antes na árvore não confunde a sujeira com trabalho parcial', async () => {
    const r = await rodar(plano(), { quedas: { F2: 1 } }, comSujeira())
    assert.equal(r.resultado.concluido, true)
    assert.doesNotMatch(r.chamadas.filter(c => c.label === 'F2')[1].prompt, /caiu no meio/)
    const parcial = await rodar(plano(), { quedas: { F2: 1 }, efeitoDaQueda: { F2: 'suja' } }, comSujeira())
    assert.match(parcial.chamadas.filter(c => c.label === 'F2')[1].prompt, /não estavam na árvore antes dela \(notas\.txt, rascunho\/ideia\.md\) são trabalho parcial/)
  })
})

describe('linha de base e diff pendente na parada', () => {
  test('o diff da feature que ficou sem commit na parada não vira linha de base na retomada', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { revisaoFeature: { F1: [1, 1, 1, 1] } }, estado)
    assert.equal(p1.resultado.parouEm, 'M1')
    assert.deepEqual(p1.resultado.retomar.arquivosPendentes, ['x/a.js'])
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.ok(!p2.logs.some(l => /mudança\(s\) não commitada\(s\) de antes/.test(l)))
    assert.deepEqual(p2.resultado.retomar?.sujeiraInicial ?? [], [])
  })
})

describe('pasta nova e retomada', () => {
  test('arquivo de pasta nova declarado pelo arquivo não vira mudança fora da lista', async () => {
    const r = await rodar(plano(), { arquivos: ['pkg/novo/A.kt'], arquivosGit: ['pkg/novo/A.kt'] })
    assert.equal(r.resultado.concluido, true)
    assert.equal(r.contar('F1 · ajuste'), 0)
    assert.match(r.prompt('commit: F1'), /git add -- 'pkg\/novo\/A\.kt'/)
  })

  test('pasta declarada pela feature que parou não vira linha de base na retomada', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const opcoes = { arquivos: ['pkg/'], arquivosGit: ['pkg/novo/A.kt'] }
    const p1 = await rodar(plano(), { ...opcoes, revisaoFeature: { F1: [1, 1, 1, 1] } }, estado)
    assert.deepEqual(p1.resultado.retomar.arquivosPendentes, ['pkg/'])
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), opcoes, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.ok(!p2.logs.some(l => /mudança\(s\) não commitada\(s\) de antes/.test(l)))
    assert.match(p2.prompt('commit: F1'), /git add -- 'pkg\/novo\/A\.kt'/)
  })
})

describe('retomada com commit de fora em arquivo da missão', () => {
  test('commit alheio entre a parada e a retomada que toca arquivo da missão fica marcado', async () => {
    const estado = { git: ['base0000'], sujo: false }
    const p1 = await rodar(plano(), { validacao: [2, 2] }, estado)
    assert.equal(p1.resultado.parouEm, 'M1')
    estado.git.push('alheio00')
    estado.porSha.alheio00 = ['x/a.js']
    const p2 = await rodar(plano({ retomar: p1.resultado.retomar }), {}, estado)
    assert.equal(p2.resultado.concluido, true)
    assert.deepEqual(p2.resultado.deForaTocando, [{ milestone: 'M1', commits: ['alheio00'], arquivos: ['x/a.js'] }])
    assert.match(p2.prompt('revisão: M1'), /Arquivos da missão tocados por commit de fora: x\/a\.js \(alheio00\)/)
  })
})

describe('prova de contrato decide o trivial', () => {
  const comUmMilestone = () => ({ milestones: [{ titulo: 'M1', criterio: 'c', features: [{ titulo: 'F1', spec: 's' }, { titulo: 'F2', spec: 'Decisão confirmada: V71' }] }] })

  test('contagem de chamadas que não confere corrige só a feature indicada, vira decisão assumida e segue', async () => {
    const contratoFalso = { M1: [
      { premissa: '18 call sites de pagar()', confere: false, classe: 'decidido', valorReal: '20 call sites', feature: 'F1' },
    ] }
    const r = await rodar(comUmMilestone(), { contratoFalso })
    assert.equal(r.resultado.concluido, true)
    assert.match(r.prompt('F1'), /Correção da prova de contrato \(valor real no código\): 18 call sites de pagar\(\) → 20 call sites/)
    assert.doesNotMatch(r.prompt('F2'), /Correção da prova de contrato/)
    assert.deepEqual(r.resultado.decisoesAssumidas, ['contrato (M1): 18 call sites de pagar() → 20 call sites'])
  })

  test('prompt do provador traz o plano e a SPEC e manda escolha nova e decisão explícita para bloqueante', async () => {
    const r = await rodar({ spec: 'docs/spec.md', plano: { milestones: comUmMilestone().milestones } })
    const p = r.prompt('contrato: M1')
    assert.match(p, /Plano do milestone "M1" \(critério: c\)\. Features a implementar:\n- F1: s\n- F2: Decisão confirmada: V71/)
    assert.match(p, /SPEC \(texto, ou caminho de arquivo no repositório para ler inteiro\):\ndocs\/spec\.md/)
    assert.match(p, /decidido: só fato descritivo de código que JÁ existe no dono/)
    assert.match(p, /bloqueante: escolha para código novo \(número de migration, nome de tabela ou rota nova, contrato novo\) que o plano não fixou, conflito concreto no código com uma decisão do plano ou da SPEC/)
    assert.doesNotMatch(p, /próxima versão livre de migration/)
  })

  test('migration, decidido sem feature ou sem valor real e bloqueante param com as perguntas juntas', async () => {
    const contratoFalso = { M1: [
      { premissa: 'próxima migration V71', confere: false, classe: 'decidido', valorReal: 'V70', feature: 'F2', pergunta: 'V71 ou V70?' },
      { premissa: 'GET /contas devolve saldo', confere: false, classe: 'bloqueante', pergunta: 'o saldo vem de onde?' },
      { premissa: 'campo idConta', confere: false, classe: 'decidido', feature: 'F1' },
      { premissa: '3 telas', confere: false, classe: 'decidido', valorReal: '4 telas' },
    ] }
    const r = await rodar(comUmMilestone(), { contratoFalso })
    assert.equal(r.resultado.parouEm, 'M1')
    assert.match(r.resultado.motivo, /prova de contrato: 4 premissa\(s\)/)
    assert.deepEqual(r.resultado.perguntas, ['V71 ou V70?', 'o saldo vem de onde?', 'confirmar: campo idConta', 'confirmar: 3 telas'])
    assert.deepEqual(r.resultado.decisoesAssumidas, [])
    assert.equal(r.contar('F1'), 0)
  })

  test('trava de migration: arquivo Flyway e a palavra migration param; rota /v2 e migração de tela não', async () => {
    const param = { M1: [
      { premissa: 'arquivo V71__x.sql', confere: false, classe: 'decidido', valorReal: 'V70__x.sql', feature: 'F1', pergunta: 'arquivo?' },
      { premissa: 'migration V71', confere: false, classe: 'decidido', valorReal: 'V70', feature: 'F1', pergunta: 'número?' },
      { premissa: 'próxima migração é V71', confere: false, classe: 'decidido', valorReal: 'V70', feature: 'F1', pergunta: 'pt-BR?' },
    ] }
    const r1 = await rodar(comUmMilestone(), { contratoFalso: param })
    assert.equal(r1.resultado.parouEm, 'M1')
    assert.deepEqual(r1.resultado.perguntas, ['arquivo?', 'número?', 'pt-BR?'])

    const seguem = { M1: [
      { premissa: 'rota /api/v2/contas', confere: false, classe: 'decidido', valorReal: '/api/v2/conta', feature: 'F1' },
      { premissa: '2 telas na migração de tela', confere: false, classe: 'decidido', valorReal: '3 telas', feature: 'F1' },
    ] }
    const r2 = await rodar(comUmMilestone(), { contratoFalso: seguem })
    assert.equal(r2.resultado.concluido, true)
    assert.equal(r2.resultado.decisoesAssumidas.length, 2)
  })

  test('decisão do plano não é premissa a provar: V71 confirmado com V69 como última no código segue sem parar', async () => {
    const contratoFalso = { M1: [
      { premissa: 'última migration local é V69, V71 livre', confere: true, evidencia: 'db/migration/V69__y.sql' },
    ] }
    const r = await rodar(comUmMilestone(), { contratoFalso })
    assert.equal(r.resultado.concluido, true)
    assert.deepEqual(r.resultado.decisoesAssumidas, [])
    assert.match(r.prompt('F2'), /Decisão confirmada: V71/)
    assert.doesNotMatch(r.prompt('F2'), /Correção da prova de contrato/)
    const p = r.prompt('contrato: M1')
    assert.match(p, /O que o plano ou a SPEC marca como decisão .* não é premissa a provar: a missão segue a decisão\. Ela só entra na lista, como bloqueante, com conflito concreto no código \(ex\.: já existe arquivo com o mesmo número de migration\)/)
  })
})
