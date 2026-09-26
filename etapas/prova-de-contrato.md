Antes de implementar, prove as premissas do milestone sobre o que ele não controla.

- Liste cada premissa sobre outro serviço, módulo ou lib: rota e método, campo e tipo, id e formato, código de erro, comportamento (ex.: "devolve 404 sem acesso").
- Confira cada uma no código do dono (controller, DTO, migration, cliente), não em documentação ou em chute. Cite arquivo e linha.
- Premissa que não confere:
  - decidido: correção óbvia no código que não muda comportamento nem contrato (contagem, número, nome, caminho,
    próxima versão livre de migration). Devolva o valor real; a missão corrige a feature e segue.
  - bloqueante: muda comportamento ou contrato, ou envolve dinheiro, acesso ou dado sensível sem resposta no código.
    Vira pergunta objetiva com a evidência. Na dúvida, risco é bloqueante.
- Não escreva código.
