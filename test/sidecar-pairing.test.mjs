#!/usr/bin/env node
/**
 * Ejercita la logica pura del sidecar: que hacer tras un cierre de socket, y como se
 * arma un mensaje de QR. Nada de esto abre un socket de verdad -docs/ENCARGO..#7
 * dice que probar el emparejamiento real necesita una cuenta y un telefono, eso es
 * T5- pero la DECISION de reconectar o no es codigo determinista y se prueba aca.
 *
 * La razon de separar esta logica en funciones puras (`decidirTrasCierre`,
 * `mensajeQr`, `qrVencido`): son las cuatro acciones distintas del usuario que
 * describe docs/ENCARGO-TRANSPORTE-UNICO.md §11 E2 -QR pendiente, sesion cerrada, sin
 * sesion y socket caido son motivos DISTINTOS, no un fallo generico- y un motivo
 * estable es contrato con el panel (bin/wa-read:126-131): cambiar el codigo lo
 * desincroniza en silencio.
 */
import { decidirTrasCierre, calcularEsperaMs, intentoTrasEvento, mensajeQr, qrVencido,
  tocaEmitirAlmacen, opcionesDeSocket, MOTIVO, PARCHES_DE_LIBRETA, QR_ROTACION_MS,
  QR_VIGENCIA_MS,
  ALMACEN_LATIDO_MS
} from '../sidecar/src/index.js'

let fallos = 0
let pruebas = 0
function ok (nombre, condicion, detalle = '') {
  pruebas += 1
  if (condicion) return console.log(`  ok    ${nombre}`)
  fallos += 1
  console.log(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`)
}

console.log('\nsidecar: motivos estables, todos distintos')
{
  const valores = Object.values(MOTIVO)
  ok('cada motivo tiene un codigo unico', new Set(valores).size === valores.length,
    JSON.stringify(valores))
  ok('los cuatro motivos de usuario existen',
    ['qr-pendiente', 'sesion-cerrada', 'sin-sesion', 'socket-caido']
      .every((m) => valores.includes(m)),
    JSON.stringify(valores))
}

console.log('\nsidecar: decidirTrasCierre por statusCode')
{
  // 401 = loggedOut: el usuario tiene que escanear un QR nuevo. Reconectar solo
  // reproduciria el mismo cierre en bucle.
  const cerrada = decidirTrasCierre(401, 1)
  ok('loggedOut (401) NO reconecta', cerrada.reconectar === false, JSON.stringify(cerrada))
  ok('y el motivo dice que hace falta sesion nueva',
    cerrada.motivo === MOTIVO.SESION_CERRADA, JSON.stringify(cerrada))

  // 515 = restartRequired: Baileys lo pide tras el primer QR escaneado. Esperar aca
  // solo demora el emparejamiento sin ganar nada.
  const reinicio = decidirTrasCierre(515, 1)
  ok('restartRequired (515) reconecta de inmediato',
    reinicio.reconectar === true && reinicio.esperaMs === 0, JSON.stringify(reinicio))
  ok('con el motivo de reinicio, no el generico',
    reinicio.motivo === MOTIVO.REINICIO_REQUERIDO, JSON.stringify(reinicio))

  // 408: en esta version de Baileys, connectionLost Y timedOut comparten el mismo
  // codigo. Que el motivo no invente cual de los dos fue es la honestidad que pide
  // el encargo, no un detalle cosmetico.
  const caido = decidirTrasCierre(408, 1)
  ok('408 reconecta con espera, no de inmediato',
    caido.reconectar === true && caido.esperaMs > 0, JSON.stringify(caido))
  ok('con el motivo de socket caido', caido.motivo === MOTIVO.SOCKET_CAIDO,
    JSON.stringify(caido))

  // Un codigo que no se reconoce (o ninguno, el socket se cayo sin razon reportada)
  // reconecta igual: negar la reconexion por defecto deja una caida colgada para
  // siempre sobre un cierre que nadie prevfunciono a mano.
  const raro = decidirTrasCierre(999, 1)
  ok('un codigo desconocido reconecta igual, con backoff',
    raro.reconectar === true && raro.esperaMs > 0 && raro.motivo === MOTIVO.DESCONOCIDO,
    JSON.stringify(raro))
  const sinCodigo = decidirTrasCierre(undefined, 1)
  ok('sin statusCode tambien reconecta', sinCodigo.reconectar === true,
    JSON.stringify(sinCodigo))
}

console.log('\nsidecar: el backoff crece y tiene tope')
{
  const esperas = [1, 2, 3, 4, 5, 6, 7, 8].map(calcularEsperaMs)
  ok('cada intento espera igual o mas que el anterior',
    esperas.every((ms, i) => i === 0 || ms >= esperas[i - 1]), JSON.stringify(esperas))
  ok('el primer intento no espera cero (hay backoff desde el intento 1)',
    esperas[0] > 0, JSON.stringify(esperas))
  ok('esta acotado: no crece sin limite',
    esperas[esperas.length - 1] === esperas[esperas.length - 2], JSON.stringify(esperas))

  // Control: un 408 en el segundo intento espera mas que en el primero, aplicando
  // el mismo backoff que calcularEsperaMs.
  const primero = decidirTrasCierre(408, 1)
  const segundo = decidirTrasCierre(408, 2)
  ok('decidirTrasCierre usa el backoff creciente, no un valor fijo',
    segundo.esperaMs > primero.esperaMs,
    `intento 1 = ${primero.esperaMs}ms, intento 2 = ${segundo.esperaMs}ms`)
}

console.log('\nsidecar: el mensaje de QR')
{
  const ahora = Date.now()
  const m1 = mensajeQr('QR-DE-PRUEBA', 1, ahora)
  ok('trae type qr', m1.type === 'qr', JSON.stringify(m1))
  ok('trae el string del QR', m1.qr === 'QR-DE-PRUEBA', JSON.stringify(m1))
  ok('trae ts', typeof m1.ts === 'number' && m1.ts === ahora, JSON.stringify(m1))
  ok('trae el contador de rotacion', m1.rotation === 1, JSON.stringify(m1))

  const m2 = mensajeQr('OTRO-QR', 2, ahora + 20000)
  ok('la rotacion sube con cada QR nuevo', m2.rotation === 2, JSON.stringify(m2))
  ok('cada QR lleva su propio ts, no uno compartido', m2.ts !== m1.ts,
    `${m1.ts} vs ${m2.ts}`)
}

console.log('\nsidecar: el panel distingue un QR vencido de uno fresco')
{
  const ahora = Date.now()
  // Las edades se miden contra QR_VIGENCIA_MS y no contra un numero escrito aca: el
  // dia que el TTL cambie, la prueba tiene que seguir probando la regla y no el valor
  // viejo. Ese fue justamente el defecto — el panel vencia a los 20 s mientras Baileys
  // generaba uno nuevo cada 60, y mostraba "el codigo vencio" dos tercios del tiempo.
  ok('un QR recien emitido no esta vencido', qrVencido(ahora, ahora) === false)
  ok('uno de media vigencia tampoco',
    qrVencido(ahora - QR_VIGENCIA_MS / 2, ahora) === false)
  ok('uno mas viejo que la vigencia si',
    qrVencido(ahora - QR_VIGENCIA_MS - 1000, ahora) === true)
  ok('el TTL viaja con el mensaje, para que el panel no tenga que adivinarlo',
    mensajeQr('X', 1, ahora).ttlMs === QR_VIGENCIA_MS,
    JSON.stringify(mensajeQr('X', 1, ahora)))
  // Control: el mismo `ts`, evaluado en dos momentos, cambia de veredicto. Si esto
  // fuera constante, el helper estaria mirando otra cosa que no es el tiempo.
  const ts = ahora - QR_VIGENCIA_MS + 5000
  ok('control: el mismo ts vence mas tarde', qrVencido(ts, ahora) === false)
  ok('y ya esta vencido diez segundos despues', qrVencido(ts, ahora + 10000) === true)
}

console.log('\nsidecar: con el sidecar emitiendo cada rotacion, el panel nunca lo ve vencido')
{
  // Regresion del defecto medido en una instalacion viva: con QR_VIGENCIA_MS igual a
  // QR_ROTACION_MS (los dos en 60 s, el arreglo anterior de esta constante), el QR
  // aparecia vencido ~40 de cada ~92 s y una rotacion entera (la numero 4) ni
  // siquiera llego a storage. La causa: el QR anterior cumple su rotacion completa
  // justo cuando nace el siguiente, y CUALQUIER demora de entrega -el salto por
  // stdout, el storage.set, el sondeo de la vinculacion- lo empuja a "vencido"
  // antes de que el nuevo este disponible para pintarse.
  //
  // Simula al sidecar emitiendo un QR por rotacion con una demora de entrega tipica
  // (200 ms) y comprueba que, en el peor instante de cada ciclo -justo cuando nace
  // la rotacion siguiente, mas la demora-, el panel TODAVIA no encuentra vencido el
  // QR anterior. Con la vigencia vieja (== rotacion) esta prueba falla.
  const DEMORA_ENTREGA_MS = 200
  const ROTACIONES = 5
  var vencidoAlgunaVez = false
  for (let r = 1; r < ROTACIONES; r++) {
    const anterior = mensajeQr('QR-' + (r - 1), r, (r - 1) * QR_ROTACION_MS)
    const peorInstante = r * QR_ROTACION_MS + DEMORA_ENTREGA_MS
    if (qrVencido(anterior.ts, peorInstante, anterior.ttlMs)) vencidoAlgunaVez = true
  }
  ok('el QR de la rotacion anterior sigue vivo hasta que llega el siguiente',
    !vencidoAlgunaVez, `vencidoAlgunaVez=${vencidoAlgunaVez}`)

  // Y dentro de una misma rotacion, en cualquier instante que se lo mire: nunca
  // vencido mientras el sidecar sigue con vida y emitiendo a tiempo.
  var vencidoDentroDeCiclo = false
  for (let r = 0; r < ROTACIONES; r++) {
    const emitido = mensajeQr('QR-' + r, r + 1, r * QR_ROTACION_MS)
    for (let leidoEn = emitido.ts + DEMORA_ENTREGA_MS;
         leidoEn < emitido.ts + QR_ROTACION_MS; leidoEn += 2000) {
      if (qrVencido(emitido.ts, leidoEn, emitido.ttlMs)) vencidoDentroDeCiclo = true
    }
  }
  ok('y en ningun punto de su propia rotacion tampoco',
    !vencidoDentroDeCiclo, `vencidoDentroDeCiclo=${vencidoDentroDeCiclo}`)
}

console.log('\nsidecar: los conteos del almacen salen CON FRENO')
{
  // Cada mensaje `store` que sale por stdout termina en un `storage.set` del worker, y
  // Orca mata al worker a los 64 eventos sin confirmar. Es el mismo mecanismo que ya se
  // llevo puesto al worker una vez por lo hablador que es Baileys en stderr — y ahi el
  // sintoma no se parecia en nada a la causa: el panel se quedaba con un QR vencido
  // para siempre. Una cuenta ocupada emite varios `messages.upsert` por segundo durante
  // la sincronizacion inicial.
  ok('recien arrancado, el primer conteo sale',
    tocaEmitirAlmacen(0, ALMACEN_LATIDO_MS + 1) === true)
  ok('el siguiente, un segundo despues, NO sale',
    tocaEmitirAlmacen(100000, 101000) === false)
  ok('pero pasado el latido, si', tocaEmitirAlmacen(100000, 100000 + ALMACEN_LATIDO_MS) === true)
  // Un desalojo es lo unico que no se puede perder: si se pierde, el usuario se entera
  // cuando una fila sale sin cuerpo y sin explicacion (§11-F2).
  ok('y un desalojo sale SIEMPRE, aunque el freno este puesto',
    tocaEmitirAlmacen(100000, 101000, true) === true)
  ok('el freno es de decenas de segundos, no de milisegundos',
    ALMACEN_LATIDO_MS >= 10000, String(ALMACEN_LATIDO_MS))
}


console.log('\nsidecar: la lista de conversaciones tiene que poder LLEGAR')
{
  // El defecto medido en la cuenta viva: 296 grupos en el almacen y CERO directos. La
  // lista inicial de conversaciones no viene por `chats.upsert` -eso es una
  // conversacion NUEVA- sino por `messaging-history.set`, y Baileys 6.7.24 solo lo
  // emite cuando `shouldSyncHistoryMessage` contesta que si
  // (lib/Socket/chats.js:778-780 -> lib/Utils/process-message.js:150,168). Con la
  // opcion sin poner, `makeWASocket` la deriva de `syncFullHistory`
  // (lib/Socket/index.js:11-12), que vale false: el evento NUNCA se emite y poner el
  // escuchador no arregla nada.
  const o = opcionesDeSocket({ version: [2, 3000, 1], auth: {}, browser: ['Chrome', 'Chrome', ''] })
  ok('pide procesar el historial que el telefono manda',
    typeof o.shouldSyncHistoryMessage === 'function' &&
    o.shouldSyncHistoryMessage({ syncType: 3 }) === true,
    JSON.stringify(Object.keys(o)))
  // Y NO pide el archivo completo: `syncFullHistory` es otra cosa — viaja como
  // `requireFullSync` en el nodo de registro que Baileys manda al vincular
  // (`generateRegistrationNode`) y le pide al telefono que vuelque todo. Mas historia es un primer arranque mas lento y
  // mas texto ajeno en disco, que es justo lo que §11-F2 manda no acumular.
  ok('sin pedir el archivo completo de conversaciones ajenas',
    o.syncFullHistory === false, JSON.stringify(o.syncFullHistory))
  // `qrTimeout` es la ROTACION, no la vigencia que lee el panel: son dos numeros
  // distintos a proposito (QR_VIGENCIA_MS > QR_ROTACION_MS, ver su comentario) y
  // esta prueba es justo la que hubiera atrapado el defecto de igualarlos nunca.
  ok('el QR rota con el periodo de Baileys, no con la vigencia que lee el panel',
    o.qrTimeout === QR_ROTACION_MS, String(o.qrTimeout))
  ok('y la vigencia que viaja con cada QR es mayor que esa rotacion',
    QR_VIGENCIA_MS > QR_ROTACION_MS, `vigencia=${QR_VIGENCIA_MS} rotacion=${QR_ROTACION_MS}`)
}

console.log('\nsidecar: el contador de intentos y el backoff al emparejar')
{
  ok('un cierre suma un intento', intentoTrasEvento(3, 'close') === 4)
  ok('conectar lo reinicia', intentoTrasEvento(7, 'open') === 0)
  // El caso que faltaba. Emparejando NO hay 'open' -es el estado al que todavia no se
  // llego- asi que si solo 'open' reinicia, el contador unicamente sube.
  ok('y un QR nuevo TAMBIEN lo reinicia', intentoTrasEvento(7, 'qr') === 0)
  ok('un evento cualquiera no lo toca', intentoTrasEvento(2, 'connecting') === 2)

  // Regresion del defecto medido en una instalacion viva (rotaciones 8..14, tres
  // cierres en cinco minutos). El ciclo real del emparejamiento es: se agota el lote
  // de refs que mando WhatsApp -> close -> reconecta -> llega un QR nuevo. Ese cierre
  // es el ciclo normal, no una caida.
  //
  // Sin el reset en 'qr', `intento` recorre 1,2,3,4,5,6... y `calcularEsperaMs` trepa
  // 1s, 2s, 4s, 8s, 16s, 30s: a partir del quinto ciclo la espera pasa el margen y el
  // QR se ve vencido el resto de CADA ciclo, empeorando cuanto mas tiempo lleva el
  // panel abierto. Que es exactamente "ahora sale siempre expirado".
  const MARGEN_MS = QR_VIGENCIA_MS - QR_ROTACION_MS
  let intento = 0
  let peorEspera = 0
  for (let ciclo = 0; ciclo < 12; ciclo += 1) {
    intento = intentoTrasEvento(intento, 'close')
    peorEspera = Math.max(peorEspera, calcularEsperaMs(intento))
    intento = intentoTrasEvento(intento, 'qr')
  }
  ok('doce ciclos de emparejamiento no agotan el margen de entrega',
    peorEspera < MARGEN_MS, `peor espera=${peorEspera}ms margen=${MARGEN_MS}ms`)

  // Y lo que el reset NO puede romper: una caida de verdad -cierres seguidos sin que
  // llegue ningun QR- tiene que seguir espaciando los reintentos.
  let caido = 0
  for (let i = 0; i < 6; i += 1) caido = intentoTrasEvento(caido, 'close')
  ok('pero una caida real sigue con backoff creciente hasta el tope',
    calcularEsperaMs(caido) === 30000, `intento=${caido} espera=${calcularEsperaMs(caido)}`)
}

console.log('\nsidecar: la libreta se PIDE, no se espera')
{
  // Las personas llegan por `resyncAppState` sobre estas colecciones. Corre en un solo
  // sitio de Baileys (`doAppStateSync`) que se auto-anula si no esta en
  // `SyncState.Syncing`, y a ese estado solo se entra dentro de la ventana de la
  // sincronizacion inicial. Si esa ventana no se completa, la libreta no se pide nunca
  // mas en esa sesion — y la lista sale con los grupos y CERO personas.
  //
  // Medido en la cuenta del dueno: 378 `app-state-sync-key-*` en disco y CERO
  // `app-state-sync-version-*`, con `accountSyncCounter` en 0.
  ok('estan las cinco colecciones de app state', PARCHES_DE_LIBRETA.length === 5,
    JSON.stringify(PARCHES_DE_LIBRETA))
  ok('incluye la libreta de contactos',
    PARCHES_DE_LIBRETA.includes('critical_unblock_low'), JSON.stringify(PARCHES_DE_LIBRETA))
  ok('y la lista de conversaciones',
    PARCHES_DE_LIBRETA.includes('regular_high') && PARCHES_DE_LIBRETA.includes('regular_low'),
    JSON.stringify(PARCHES_DE_LIBRETA))
  ok('la lista es inmutable: es un contrato con Baileys, no una preferencia',
    Object.isFrozen(PARCHES_DE_LIBRETA))
}

console.log(`\n${pruebas - fallos}/${pruebas} en verde`)
process.exit(fallos ? 1 : 0)
