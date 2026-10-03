# Firmware do GrowAI

Duas placas, dois projetos PlatformIO independentes:

| Pasta | Placa | O que faz |
|---|---|---|
| [esp32-main/](esp32-main/) | ESP32 DevKit 30 pinos | irrigação, fotoperíodo, ventilação, nutrientes, telemetria |
| [esp32-cam/](esp32-cam/) | ESP32-CAM AI-Thinker | uma foto a cada 30 min |

As duas **não se falam**. Cada uma conversa só com o backend, e é sempre ela que
inicia a conexão. O contrato HTTP está em [PROTOCOLO.md](PROTOCOLO.md).

O controle é **sempre local**: histerese, corte de bomba em 20 s, pausa de
absorção, limite diário de nutriente e corte por sensor inválido funcionam sem
Wi-Fi. Se a internet cair, a planta continua sendo cuidada.

---

## 1. Ligação dos fios

### ESP32 DevKit (placa principal)

| Componente | Fio / pino dele | Vai em | Observação |
|---|---|---|---|
| Sensor capacitivo de umidade | VCC | **3V3** | Ver o aviso abaixo |
| | GND | GND | |
| | AOUT | **GPIO 34** | |
| DS18B20 (temperatura) | VDD (vermelho) | 3V3 | |
| | GND (preto) | GND | |
| | DQ (amarelo) | **GPIO 25** | Resistor de **4,7 kΩ entre DQ e 3V3** |
| Módulo relé 4 canais | VCC | 5V | |
| | GND | GND | Tem que ser o **mesmo GND** do ESP32 |
| | IN1 | **GPIO 26** | bomba d'água |
| | IN2 | **GPIO 27** | LED Grow (UV) |
| | IN3 | **GPIO 14** | 2 microventiladores 12 V |
| | IN4 | **GPIO 32** | minibomba de nutrientes |

> **Alimente o sensor capacitivo em 3V3, não em 5 V.** Em 5 V a saída analógica
> passa de 3,3 V e queima a entrada do GPIO 34, que não tem proteção. É o erro
> mais caro dessa montagem.

As cargas (bomba, LED, ventiladores, minibomba) vão no contato **NO**
(normalmente aberto) de cada relé, com a fonte **delas**, não a do ESP32.

### ESP32-CAM (AI-Thinker + placa MB)

| Componente | Vai em | Observação |
|---|---|---|
| Placa MB | USB | 5 V e gravação vêm por aqui |
| Câmera | conector flat | Pinagem padrão AI-Thinker, nada para ligar à mão |
| LED de flash | GPIO 4 | Já é da placa |

Não usa cartão SD. Não precisa de nenhum fio até o ESP32 principal.

### Alimentação

| O que | Precisa de | Cuidado |
|---|---|---|
| ESP32 DevKit | 5 V pela USB, ou 5 V no VIN | |
| Bobinas do relé | 5 V, ~70–80 mA **cada** | 4 relés ligados podem passar de 300 mA. Use fonte 5 V própria, GND comum com o ESP32 |
| ESP32-CAM | 5 V com folga (1 A) | Fonte fraca ou fio fino = brownout na hora do flash. Ver seção 6 |
| Bomba, LED Grow, ventiladores, minibomba | fonte 12 V própria | Passa pelo contato do relé, nunca pelo ESP32 |

Regra que resolve 90% dos fantasmas: **todos os GND juntos**, e nenhuma carga
de 12 V tirando corrente do regulador do ESP32.

---

## 2. Compilar e gravar

O comando é `pio`. Se ele não estiver no PATH (foi o caso aqui no Windows), use
`python -m platformio` no lugar — é o mesmo programa.

```bash
pip install platformio          # uma vez só
```

### Configurar: pelo celular, não pelo código

**Você não precisa editar nenhum arquivo para trocar de rede.** Wi-Fi, endereço
da API e chave da placa ficam guardados na memória da placa (NVS) e são
preenchidos por um portal no celular:

1. A placa tenta conectar e não consegue.
2. Ela cria a própria rede Wi-Fi: **`GrowAI-setup`** (senha `growai123`).
3. Conecte o celular nessa rede. A página de configuração abre sozinha (como
   em Wi-Fi de hotel). Se não abrir, acesse `http://192.168.4.1`.
4. Escolha a sua rede, digite a senha e preencha os dois campos:
   - **Endereço da API** — `https://growai-backend.vercel.app/api` (sem barra no fim)
   - **Chave desta placa** — a chave gerada por `criar-dispositivo`
5. Salve. Ela grava e reinicia já conectada.

Pronto: levou para a escola, trocou de roteador, usou o 4G do celular — é só
repetir, sem computador e sem cabo.

#### Quando o portal abre

| Placa | Abre quando |
|---|---|
| ESP32 principal | nunca foi configurada, **ou** você segura o botão **BOOT** enquanto liga |
| ESP32-CAM | nunca foi configurada, **ou** falha 3 ciclos seguidos ao conectar |

A CAM não tem botão acessível (o GPIO 0 dela é o clock da câmera), por isso o
gatilho é a falha repetida: se a rede mudou de nome ou de senha, em ~1h30 ela
abre o portal sozinha.

O portal fica no ar por 3 minutos. Ninguém configurou? A placa reinicia e volta
ao normal.

> **Na placa principal o portal NÃO para a horta.** Ele roda em modo não
> bloqueante: enquanto você configura pelo celular, a irrigação, a luz e a
> ventilação continuam decidindo sozinhas. Era a parte mais importante de
> acertar — o padrão da biblioteca trava tudo num laço até alguém configurar.

#### E o secrets.h?

Continua existindo, mas **em branco e opcional**. Ele é só o valor de fábrica:
vale enquanto a NVS estiver vazia, e o que você configurar pelo portal sempre
vence. Só vale preencher se quiser gravar várias placas já configuradas de uma
vez.

```
cp firmware/esp32-main/include/secrets.example.h firmware/esp32-main/include/secrets.h
cp firmware/esp32-cam/include/secrets.example.h  firmware/esp32-cam/include/secrets.h
```

Ele está no `.gitignore`, então nada do que você puser ali vai para o repositório.

#### Apagar a configuração

Para zerar e começar do portal de novo, use a opção **Erase** na própria página
do portal, ou regrave com `pio run -t erase` seguido do upload normal.

### ESP32 principal (pela USB)

```bash
pio run -d firmware/esp32-main                    # só compila
pio run -d firmware/esp32-main -t upload          # grava
pio device monitor -b 115200                      # abre o Serial
```

Se não achar a placa, segure o botão **BOOT** enquanto o upload começa e solte
quando aparecer "Connecting...".

### ESP32-CAM (pela placa MB)

```bash
pio run -d firmware/esp32-cam -t upload
```

A placa MB normalmente reseta sozinha. Se der `Failed to connect`:

1. Ligue **IO0 no GND** com um jumper;
2. aperte **RST** (ou tire e recoloque a USB);
3. rode o upload;
4. **tire o jumper** e aperte RST de novo — senão ela fica em modo de gravação
   e não roda o firmware.

### Tamanho atual

| Projeto | RAM | Flash |
|---|---|---|
| esp32-main | 15,0% (49 kB de 320 kB) | 77,0% (1,01 MB de 1,31 MB) |
| esp32-cam | 16,0% (52 kB de 320 kB) | 35,7% (1,12 MB de 3,15 MB) |

---

## 3. Calibrar o sensor de umidade

O firmware imprime o valor cru do ADC em todo ciclo, e ele também vai na
telemetria como `umidade_bruto`:

```
14:22:07  umid 52% (2410)  temp 24.8C  MONITORANDO  B0 N0 L1 V0 ...
                     ^^^^ este
```

1. Grave o firmware e abra o Serial.
2. **Sensor seco, no ar.** Espere estabilizar e anote o bruto. Esse é o `AR`
   (deve dar por volta de 3200).
3. **Sensor na água**, até a linha marcada na plaquinha — **não passe dela**,
   a parte de cima não é à prova d'água. Anote o bruto. Esse é o `AGUA`
   (por volta de 1350).
4. Ponha os dois valores no topo de
   [esp32-main/src/main.cpp](esp32-main/src/main.cpp):
   ```cpp
   const int AR = 3200, AGUA = 1350;
   ```
5. Grave de novo e confira: no ar tem que dar perto de 0%, na água perto de 100%.

Calibre **com o sensor enterrado no substrato que você vai usar de verdade**.
Terra, fibra de coco e perlita dão leituras diferentes.

Se aparecer `umid INVALIDA`, o bruto saiu de 500–4000 — normalmente fio solto
ou sensor em curto. A bomba é cortada na hora nesse caso.

---

## 4. Medir a vazão da minibomba (escolher `nutri_s`)

`nutri_s` é quantos **segundos** a minibomba fica ligada na dose do dia. O
limite duro é **30 s por dia**, e o firmware não deixa passar.

1. Suba o mock (seção 5) e deixe a placa conectada nele.
2. Ponha a mangueirinha da minibomba num copo medidor ou numa seringa.
3. Ligue a bomba por 10 s:
   ```
   http://localhost:3001/mock/cmd?rele=nutri&acao=ligar&dur_s=10
   ```
4. Meça quantos mL saíram. Divida por 10 → **mL por segundo**.
5. Conta final:

   ```
   nutri_s = mL que você quer por dia ÷ mL por segundo
   ```

   Exemplo: saíram 25 mL em 10 s → 2,5 mL/s. Para dosar 15 mL por dia,
   `nutri_s = 15 ÷ 2,5 = 6`.

6. Mande o valor pelo mock:
   ```
   http://localhost:3001/mock/config?nutri_s=6
   ```

Se a conta der mais de 30, a minibomba é rápida demais para a dose que você
quer: dilua mais o nutriente no reservatório em vez de aumentar o tempo.

---

## 5. Testar com o mock, na rede local

O [tools/mock-server.js](tools/mock-server.js) finge o backend inteiro. Node
puro, sem `npm install`.

```bash
node firmware/tools/mock-server.js
```

Ele imprime os IPs da máquina na rede:

```
GrowAI mock na porta 3001
Chave da placa main (telemetria): teste123-main
Chave da placa cam  (foto):       teste123-cam

Use um destes como endereço da API:
  http://192.168.18.22:3001/api
```

Agora configure **cada placa pelo portal** (segure BOOT ao ligar a principal),
pondo esse endereço e a chave **daquela** placa:

| Placa | Endereço da API | Chave |
|---|---|---|
| principal | `http://192.168.18.22:3001/api` | `teste123-main` |
| câmera | `http://192.168.18.22:3001/api` | `teste123-cam` |

Terminou de testar? Abra o portal de novo e troque o endereço de volta para
`https://growai-backend.vercel.app/api` — sem recompilar nada.

O mock separa as chaves igual ao backend, de propósito: se você trocar as duas,
o erro aparece aqui em casa e não só depois de subir para a Vercel. Para usar as
chaves de produção no mock:

```bash
DEVICE_KEY_MAIN=<chave main> DEVICE_KEY_CAM=<chave cam> node firmware/tools/mock-server.js
```

> **O Windows vai perguntar se libera o Node no firewall. Diga sim, para redes
> privadas.** Se você já negou antes, a placa não vai conseguir conectar e o
> Serial mostra timeout. Libere em Firewall do Windows → Permitir um aplicativo.

### Rotas para abrir no navegador

| Para quê | URL |
|---|---|
| Ver tudo: última telemetria, config, fila, fotos | `http://localhost:3001/mock/estado` |
| Ligar o ventilador por 1 min | `http://localhost:3001/mock/cmd?rele=vent&acao=ligar&dur_s=60` |
| Devolver o ventilador ao automático | `http://localhost:3001/mock/cmd?rele=vent&acao=desligar` |
| Mudar a histerese | `http://localhost:3001/mock/config?umid_liga=50&umid_desliga=70` |
| Mudar o fotoperíodo | `http://localhost:3001/mock/config?luz_on=07:00&luz_off=19:00` |

As fotos caem em `tools/fotos/` (pasta ignorada pelo Git).

O mock **valida a config com as mesmas regras do firmware**, então se você
errar um valor o erro aparece no navegador na hora, e não escondido no Serial:

```json
{ "erro": "config recusada pelo mock",
  "detalhes": ["umid_desliga (52) precisa ser >= umid_liga+5 (55)"] }
```

### Um roteiro de teste que cobre o básico

1. Suba o mock e grave as duas placas.
2. **Telemetria:** o log do mock tem que mostrar uma linha a cada ~15 s.
3. **Config:** abra `/mock/config?umid_liga=50&umid_desliga=70`. Na próxima
   telemetria o Serial da placa mostra `[cfg] aceita e salva na NVS`.
4. **Config recusada:** `/mock/config?nutri_s=99` → o mock recusa antes de
   mandar. Para testar a recusa **na placa**, edite `estado.config` no
   mock-server à mão.
5. **NVS:** desligue e ligue a placa. O Serial tem que mostrar
   `[cfg] carregada da NVS` com os valores novos, **mesmo com o mock desligado**.
6. **Comando manual:** `/mock/cmd?rele=vent&acao=ligar&dur_s=60`. O ventilador
   liga, e no log do mock aparece `ack: comando 1 ... confirmado`. Depois de
   60 s ele volta ao automático sozinho.
7. **Limite duro:** `/mock/cmd?rele=bomba&acao=ligar&dur_s=600`. O Serial mostra
   `bomba ligado por 20 s`, não 600 — o firmware cortou.
8. **Sem internet:** feche o mock. A placa tem que continuar regando e
   acendendo a luz, com o Serial mostrando o backoff (15 → 30 → 60 s).
9. **Foto:** espere a janela (minuto `:00` ou `:30`). A luz apaga por 40 s, a
   CAM acorda, dá o flash, e o JPEG aparece em `tools/fotos/`.

---

## 6. Problemas comuns

### `Brownout detector was triggered` na CAM

A placa reinicia, normalmente na hora do flash. É **falta de corrente**, não bug
de software — e o detector fica ligado de propósito, porque desligar ele só
esconde o aviso e troca o reset por foto corrompida e flash gravado na memória.

O que resolver, em ordem de eficácia:

1. Fonte de 5 V com **1 A ou mais** (a USB do notebook muitas vezes não dá);
2. cabo USB **curto e grosso** — cabo fino de 2 m derruba a tensão sozinho;
3. capacitor eletrolítico de **470 µF ou mais** entre 5 V e GND, o mais perto
   possível da placa;
4. não alimente a CAM pelo regulador 3V3 do ESP32 principal.

### A placa não acha a rede

**Rede 5 GHz.** O ESP32 só fala **2,4 GHz**. Se seu roteador usa o mesmo nome
para as duas faixas, ele pode nem aparecer. Separe os nomes, ou use o roteador
do celular em 2,4 GHz.

**Rede com portal de login** (escola, faculdade, café): **não funciona**, e não
tem como contornar no firmware — a placa não tem navegador para aceitar os
termos. Use o roteador do celular, e configure pelo portal da placa na hora.

Confira também: senha com acento ou caractere especial, e SSID escrito com
maiúscula/minúscula exatamente igual.

### Serial mostra `401 chave invalida` a cada ciclo

O Wi-Fi está bem, a placa alcança o servidor, mas ele recusa a chave. Em ordem:

1. **As chaves estão trocadas** entre as duas placas? É a causa mais comum. A
   telemetria só aceita a chave `main`, a foto só a `cam`;
2. a chave foi copiada com espaço ou quebra de linha no fim?
3. a chave foi gerada para **outra estação**?
4. a chave foi regerada depois de você configurar a placa? O script imprime uma
   vez e guarda só o hash — gerar de novo invalida a anterior.

Para corrigir: abra o portal (BOOT na principal, ou espere 3 ciclos na CAM) e
cole a chave certa. **Não precisa recompilar nem ligar o cabo.**

A placa tenta de novo a cada 60 s e **segue regando normalmente** enquanto isso.

### DS18B20 lendo `-127`

Significa "não achei nenhum sensor no barramento". O firmware manda `temp_c:
null` e segue funcionando — os ventiladores passam a rodar só pelo ciclo por
hora, sem a parte de temperatura.

Causas, em ordem de frequência:

1. **Falta o resistor de 4,7 kΩ entre DQ e 3V3.** Sem ele não funciona nunca;
2. fios trocados — no DS18B20 de sonda: vermelho VDD, preto GND, amarelo DQ;
3. o sensor está num GPIO de 34 a 39. **Não pode**: esses pinos são só entrada
   e o OneWire precisa escrever. Use o 25;
4. sonda falsificada (comum em kit barato). Teste com outra.

Aparecer `85.0` na primeira leitura é normal: é o valor de reset do chip, e o
firmware trata como inválido.

### Os relés dão um "tec" quando ligo a placa

Um estalo só, no boot, é normal: o módulo relé assume um estado antes do
`setup()` rodar. O firmware chama `pinMode` e desliga tudo como primeira coisa
do `setup()`, então dura milissegundos.

**Os ventiladores podem dar um pulso maior**, porque o GPIO 14 solta um sinal
PWM durante o boot da ROM, antes de qualquer código nosso. Não tem como evitar
por software. Para ventilador não faz mal. Se incomodar, troque o GPIO 14 por
outro pino livre (o 13 serve) em
[esp32-main/src/main.cpp](esp32-main/src/main.cpp).

### A luz não acende / acende fora de hora

- Enquanto o NTP não responde, a luz fica **acesa de propósito** (é melhor errar
  para o lado da planta viva). O Serial mostra a hora como `--:--:--` e a
  telemetria manda `hora_valida: false`.
- Ela apaga por 40 s a cada meia hora. Isso é a janela de foto, não defeito.
- `luz_on` igual a `luz_off` significa 24 h acesa.

### `pio: command not found`

O pip instalou, mas o script não entrou no PATH. Use `python -m platformio` em
todos os comandos deste README.

### A bomba não liga

Confira na ordem:

1. `umid INVALIDA` no Serial? Com sensor inválido a bomba é **bloqueada**;
2. o estado está `ABSORVENDO`? São 5 min de pausa obrigatória depois de regar;
3. a umidade está acima de `umid_liga`? Então não tem nada para fazer;
4. a carga está no contato **NO** do relé, não no NC?
