Antes de implementar, prove as premissas do milestone sobre o que ele não controla.

- Liste cada premissa sobre outro serviço, módulo ou lib: rota e método, campo e tipo, id e formato, código de erro, comportamento (ex.: "devolve 404 sem acesso").
- Confira cada uma no código do dono (controller, DTO, migration, cliente), não em documentação ou em chute. Cite arquivo e linha.
- Premissa que não confere:
  - decidido: só fato descritivo de código que já existe no dono (contagem de chamadas, caminho, nome atual de símbolo
    ou campo existente). Devolva o valor real e a feature afetada; a missão corrige essa feature e segue.
  - bloqueante: escolha para código novo (número de migration, nome de tabela ou rota nova, contrato novo), o que o
    plano ou a SPEC marca como decisão, divergência que muda comportamento ou contrato, ou que envolve dinheiro,
    acesso ou dado sensível sem resposta. Vira pergunta objetiva com a evidência. Na dúvida, bloqueante.
- Não escreva código.
