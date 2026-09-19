"""El lexico de voseo, en un solo lugar, para todo lo que este repo escribe en espanol.

El usuario es colombiano y el tono que el propio plugin configura dice "sin voseo".
El chequeo viejo vivia dentro de check-prompts, solo miraba prompts/ y harness/, y su
patron dependia de la tilde final. Este repo escribe el espanol SIN tildes, asi que un
panel lleno de "abri", "volve", "Reinstalalo" y "Apreta" pasaba verde mientras el
usuario lo leia en pantalla.

Las formas se generan a partir de listas de verbos, en las cuatro variantes con las que
el voseo aparece de verdad aca:

  1. imperativo con tilde final               mirá, volvé, abrí
  2. imperativo + clitico, sin tilde          dejala, ponele, escanealo, reinstalalo
  3. imperativo pelado de -ir                 abri, elegi, corregi, pedi
  4. imperativo pelado que diptonga en tu     apreta (tu: aprieta), volve (tu: vuelve)
  5. presente con tilde                       ponés, controlás, elegís

Un imperativo de -ar sin tilde ("mira") es identico al de tu y no se puede acusar sin
delatar media pagina; por eso la 3 y la 4 son listas donde la forma de tu es OTRA
palabra. Por la misma razon se dejan afuera las formas que tambien son tercera persona
("hace", "pone", "sabe") o palabras de otro idioma ("create", "move", "unite"): un
chequeo que grita donde no hay falta se termina apagando.
"""

# Raices (infinitivo menos la terminacion) de los verbos con que este repo le da una
# instruccion al usuario. Crece cuando aparece un verbo nuevo en un copy.
AR = """abandon actualiz agreg ajust anot apag apret arranc autoriz avis baj borr
busc cambi carg cerr coment complet conect confirm cont copi cort dej descart
desvincul edit elimin empez enlaz entr escane esper filtr fij guard habl instal
intent jal llam llev mand marc mir mostr mud nombr orden pag par peg pens prob
control cre program qued quit recarg record reinici reinstal report revis sac
sincroniz sonde sum
termin toc tom us valid verific vincul""".split()

ER = """aprend atend beb com corr deb entend hac le mov perd pon prend quer recog resolv
respond romp sab ten vend volv""".split()

IR = """abr admit asum compart conclu correg cumpl dec decid dirig discut divid eleg
escrib exig imprim insist med ped permit recib repet resist sal segu sent serv sub
sufr suger ven viv""".split()

CLITICOS = ["lo", "la", "le", "los", "las", "les", "me", "te", "nos", "se",
            "melo", "mela", "selo", "sela", "telo", "tela"]

# Imperativos pelados, sin tilde, cuya forma de tu es otra palabra: "volve" contra
# "vuelve", "apreta" contra "aprieta". Solo estos: en el resto, el pelado de vos y el
# de tu se escriben igual.
# "pode" y "quere" no estan: poder y querer no tienen imperativo, y "pode" es ademas
# el subjuntivo de podar.
PELADOS = ["volve", "tene", "entende", "atende", "perde",
           "apreta", "cerra", "empeza", "comenza", "recorda", "encontra", "proba",
           "juga", "calenta", "colga", "sona", "vola"]

# Pronombres, presentes de voseo e imperativos reflexivos frecuentes.
IRREGULARES = ["sos", "vos", "tenes", "tenés", "podes", "podés", "queres", "querés",
               "venis", "venís", "decis", "decís", "hacés", "sabés", "vivís",
               "sentís", "oís", "andate", "fijate", "quedate", "acordate",
               "sentate", "apurate", "mirate", "levantate"]

# Formas generadas que son palabra corriente en otro idioma o en espanol: acusarlas
# convierte el chequeo en ruido y el ruido termina en un `# noqa`.
QUITAR = {"create", "unite", "move", "delete", "tomate", "comparte", "conclui",
          "terminales"}


def formas() -> set:
    """Toda forma de voseo que este repo puede llegar a escribir, en minuscula."""
    out = set()
    for raices, tilde, pelada, presente in ((AR, "á", "a", "ás"), (ER, "é", "e", "és"),
                                            (IR, "í", "i", "ís")):
        for r in raices:
            out.add(r + tilde)
            out.add(r + presente)
            for c in CLITICOS:
                out.add(r + pelada + c)
    for r in IR:
        out.add(r + "i")
    out.update(PELADOS)
    out.update(IRREGULARES)
    return out - QUITAR


FORMAS = formas()
