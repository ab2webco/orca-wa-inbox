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
  tocaEmitirAlmacen, opcionesDeSocket, salidaTrasCierre, repetidosTrasCierre, MOTIVO,
  PARCHES_DE_LIBRETA, CIERRES_REPETIDOS_TOPE, CIERRES_VENTANA_MS,
  QR_ROTACION_MS, QR_VIGENCIA_MS, SALIDA, LATIDO_LINEA_MS, mensajeLatido,
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

  // 500: Baileys lo usa para la sesion mala Y para un error pasajero del servidor
  // ("Stream Errored"). Borrar las credenciales al primero dejo la linea del dueno
  // pidiendo QR tras una actualizacion (2026-10-03): se reintenta, y solo se borran si
  // se repite seguido.
  const mala1 = decidirTrasCierre(500, 1, 1)
  ok('un 500 suelto reconecta con espera y NO borra las credenciales',
    mala1.reconectar === true && mala1.borrarCredenciales === false && mala1.esperaMs > 0,
    JSON.stringify(mala1))
  const malaTope = decidirTrasCierre(500, 4, CIERRES_REPETIDOS_TOPE + 1)
  ok('500 repetido pasado el tope: ahi si se borran',
    malaTope.reconectar === false && malaTope.borrarCredenciales === true &&
    malaTope.motivo === MOTIVO.SESION_CERRADA, JSON.stringify(malaTope))
  ok('un 401 borra al primero: WhatsApp cerro la sesion de verdad',
    decidirTrasCierre(401, 1, 1).borrarCredenciales === true)

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

console.log('\nsidecar: las credenciales muertas se tiran, no se reusan')
{
  // Medido en la maquina del dueno (2026-10-01): WhatsApp cerro la sesion con 401 y
  // `creds.json` se quedo con `me` puesto. Con `me`, Baileys 6.7.24 hace LOGIN y no
  // registro (lib/Socket/socket.js:157-162), asi que ningun reinicio podia producir un
  // QR: el mismo 401, para siempre. La credencial muerta hay que tirarla.
  const cerrada = decidirTrasCierre(401, 1)
  ok('un 401 pide borrar las credenciales', cerrada.borrarCredenciales === true,
    JSON.stringify(cerrada))
  // 500 es `badSession` cuando se repite: la sesion guardada ya no la reconoce WhatsApp,
  // y reconectar con ella es el mismo callejon que el 401. Uno suelto se reintenta.
  const mala = decidirTrasCierre(500, 1, CIERRES_REPETIDOS_TOPE + 1)
  ok('un 500 (badSession) repetido tambien', mala.borrarCredenciales === true &&
    mala.reconectar === false && mala.motivo === MOTIVO.SESION_CERRADA,
    JSON.stringify(mala))
  // Control: lo que se cura solo NO toca las credenciales. Borrarlas ante una caida de
  // red le pediria al dueno escanear un QR por un wifi que se corto.
  for (const codigo of [408, 515, 428, 503, 500, undefined]) {
    const d = decidirTrasCierre(codigo, 1)
    ok(`un ${codigo ?? 'cierre sin codigo'} no borra nada`, d.borrarCredenciales === false,
      JSON.stringify(d))
  }

  // El sidecar no borra la carpeta el mismo: sale con un codigo propio y el worker
  // reusa el MISMO desvincular del boton del panel, que ya espera a que el proceso
  // muera antes de borrar (una credencial a medias fue el "desvinculo y ya no conecta"
  // de produccion). Un codigo de salida es el contrato, y no la ultima linea de stdout,
  // porque el evento de salida del hijo puede llegar antes que su ultima linea.
  ok('los codigos de salida son distintos entre si',
    new Set(Object.values(SALIDA)).size === Object.values(SALIDA).length, JSON.stringify(SALIDA))
  ok('y ninguno se confunde con un exit 0 ni con un reventon (1)',
    Object.values(SALIDA).every((c) => Number.isInteger(c) && c > 1 && c < 126),
    JSON.stringify(SALIDA))
  ok('tras un 401 el sidecar sale con el codigo de credenciales muertas',
    salidaTrasCierre(cerrada) === SALIDA.CREDENCIALES_MUERTAS, String(salidaTrasCierre(cerrada)))
  ok('tras un cierre que reconecta no sale', salidaTrasCierre(decidirTrasCierre(408, 1)) === null,
    String(salidaTrasCierre(decidirTrasCierre(408, 1))))
}

console.log('\nsidecar: 403, 411 y 440 dejan de reintentar para siempre')
{
  // Antes caian en el "cualquier otro codigo reconecta" y reconectaban para siempre.
  // 440 (connectionReplaced) es otro cliente usando la misma sesion: reconectar le
  // quita la sesion al otro, el otro se la quita a este, y asi sin fin. 403 (forbidden)
  // y 411 (multideviceMismatch) no se curan reintentando. Cada uno con su motivo,
  // porque lo que el dueno tiene que hacer es distinto en cada uno.
  const casos = [
    [440, MOTIVO.SESION_REEMPLAZADA, 'sesion-reemplazada'],
    [403, MOTIVO.ACCESO_DENEGADO, 'acceso-denegado'],
    [411, MOTIVO.MULTIDISPOSITIVO, 'multidispositivo']
  ]
  for (const [codigo, motivo, texto] of casos) {
    ok(`${codigo}: tiene motivo propio (${texto})`, motivo === texto, String(motivo))
    const primero = decidirTrasCierre(codigo, 1, 1)
    ok(`${codigo}: la primera vez reintenta, con espera`,
      primero.reconectar === true && primero.esperaMs > 0 && primero.motivo === texto &&
      primero.borrarCredenciales === false, JSON.stringify(primero))
    const ultimo = decidirTrasCierre(codigo, 1, CIERRES_REPETIDOS_TOPE)
    ok(`${codigo}: hasta el tope sigue reintentando`, ultimo.reconectar === true,
      JSON.stringify(ultimo))
    const pasado = decidirTrasCierre(codigo, 1, CIERRES_REPETIDOS_TOPE + 1)
    ok(`${codigo}: pasado el tope se rinde, con su motivo`,
      pasado.reconectar === false && pasado.motivo === texto &&
      pasado.borrarCredenciales === false, JSON.stringify(pasado))
    ok(`${codigo}: y sale con el codigo de "me rendi", no con el de credenciales muertas`,
      salidaTrasCierre(pasado) === SALIDA.RENDIDO, String(salidaTrasCierre(pasado)))
  }

  // La cuenta NO la reinicia un 'open'. Un 440 es justo eso: conecta, el otro cliente
  // la reclama, cierra, reconecta, conecta... Si `open` la bajara -como baja `intento`-
  // el tope no se alcanzaria nunca.
  let previo = null
  let rendido = false
  for (let vuelta = 0; vuelta < 10 && !rendido; vuelta += 1) {
    previo = repetidosTrasCierre(previo, 440, 1000 * vuelta)
    rendido = decidirTrasCierre(440, 1, previo.veces).reconectar === false
  }
  ok('un 440 que vuelve tras cada conexion termina rindiendose', rendido,
    JSON.stringify(previo))

  // Y lo que no es repeticion no suma: otro codigo empieza de cero, y un 440 aislado
  // horas despues de otro no hereda la cuenta vieja.
  const a = repetidosTrasCierre({ codigo: 440, veces: 3, ts: 0 }, 408, 1000)
  ok('un codigo distinto empieza la cuenta de cero', a.veces === 1 && a.codigo === 408,
    JSON.stringify(a))
  const b = repetidosTrasCierre({ codigo: 440, veces: 3, ts: 0 }, 440,
    CIERRES_VENTANA_MS + 1)
  ok('el mismo codigo fuera de la ventana tambien', b.veces === 1, JSON.stringify(b))
  const c = repetidosTrasCierre({ codigo: 440, veces: 2, ts: 0 }, 440, 1000)
  ok('dentro de la ventana suma', c.veces === 3, JSON.stringify(c))

  // Control: lo que ya reconectaba sigue reconectando aunque se repita, porque se cura
  // solo (una red que se cae diez veces sigue siendo una red).
  ok('un 408 repetido no se rinde', decidirTrasCierre(408, 1, 50).reconectar === true)
}

console.log('\nsidecar: el latido que prueba que la linea sigue viva')
{
  // "Conectado" salia de la ultima foto guardada en storage, que no caduca nunca: con
  // el worker o el sidecar muertos, el panel seguia diciendo "conectado" una semana
  // despues. El latido es lo que permite caducarla.
  //
  // Cada linea de stdout es un `storage.set` del worker, y Orca mata al worker a los 64
  // sin confirmar: el latido es de a minuto, no de a segundo.
  ok('late cada minuto o mas, no cada segundo', LATIDO_LINEA_MS >= 60000,
    String(LATIDO_LINEA_MS))
  ok('y no mas seguido que los conteos del almacen, que ya tienen freno',
    LATIDO_LINEA_MS >= ALMACEN_LATIDO_MS, `${LATIDO_LINEA_MS} vs ${ALMACEN_LATIDO_MS}`)
  const m = mensajeLatido(true, 1758500000000)
  ok('el mensaje dice que es un latido', m.type === 'latido', JSON.stringify(m))
  ok('trae su marca de tiempo', m.ts === 1758500000000, JSON.stringify(m))
  ok('y si el socket esta abierto en ese momento', m.conectado === true &&
    mensajeLatido(false, 1).conectado === false, JSON.stringify(m))
  // Un latido no lleva nada de nadie: termina en storage, que lee el panel.
  ok('y nada mas', Object.keys(m).sort().join(',') === 'conectado,ts,type',
    JSON.stringify(m))
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
