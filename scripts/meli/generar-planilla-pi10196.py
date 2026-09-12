#!/usr/bin/env python3
# Genera la planilla de carga masiva a Mercado Libre para los SKUs nuevos de la PI10196.
#
#   pip install openpyxl && python3 scripts/meli/generar-planilla-pi10196.py
#
# Los datos de los ítems salen de Supabase: importaciones.id = IMP1780969938902
# (notas = "PI10196"), campo items — y están fijados acá abajo en ITEMS. Son los
# 22 ítems cuyo SKU todavía no existe en la tabla productos.

import os

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.comments import Comment
from openpyxl.formatting.rule import CellIsRule
from openpyxl.utils import get_column_letter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "PI10196-carga-masiva-MELI.xlsx")

# ── Paleta / estilos ──────────────────────────────────────────────────────────
F = "Arial"
AZUL   = Font(name=F, size=10, color="0000FF")            # input hardcodeado
NEGRO  = Font(name=F, size=10)                            # fórmula / texto
VERDE  = Font(name=F, size=10, color="008000")            # link a otra hoja
BOLD   = Font(name=F, size=10, bold=True)
H1     = Font(name=F, size=14, bold=True)
H2     = Font(name=F, size=11, bold=True)
MUTED  = Font(name=F, size=9, color="666666")
HDRF   = Font(name=F, size=10, bold=True, color="FFFFFF")

HDRFILL = PatternFill("solid", fgColor="2F3E4E")
YELLOW  = PatternFill("solid", fgColor="FFFF00")
GREYFILL= PatternFill("solid", fgColor="EFEFEF")
EJFILL  = PatternFill("solid", fgColor="FFF2CC")

THIN = Side(style="thin", color="BFBFBF")
BOX  = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

WRAP = Alignment(wrap_text=True, vertical="top")
CTR  = Alignment(horizontal="center", vertical="center")

# ── Datos: los 22 SKUs nuevos de la PI10196 ───────────────────────────────────
# Fuente: Supabase, importaciones.id = IMP1780969938902 (notas = "PI10196"),
# campo items. Son los ítems cuyo SKU no existe todavía en la tabla productos.

CAT_SOP = "Soportes de Celular"
CAT_ESP = "Espejos"
CAT_EXT = "Extensores de Espejo"
CAT_MAN = "Manubrios y Manillares"

ROSCA = {"F": "horario", "R": "antihorario"}

def ext_desc(sku):
    # EXT-ESP-{int}-{ext}-001  ->  ("8mm horario", "10mm antihorario")
    _, _, a, b, _ = sku.split("-")
    med_a, sen_a = a[:-1], ROSCA[a[-1]]
    med_b, sen_b = b[:-1], ROSCA[b[-1]]
    return f"{med_a}mm {sen_a}", f"{med_b}mm {sen_b}"

# (sku, nombre, qty, costo_usd, grupo, markup, comparable_sku, comparable_precio)
ITEMS = [
    ("SOP-CEL-MAN-001", "Soporte Celular Moto Universal Manillar Negro Ajustable",
     100, 1.00, CAT_SOP, 8.0, None, None),
    ("SOP-CEL-ESP-001", "Soporte Celular Moto Universal Espejo Negro Ajustable",
     100, 1.00, CAT_SOP, 8.0, None, None),
    ("ESP-CIR-001", "Espejos de Puño Circulares Moto Universal Manillar 7/8 Negro",
     10, 3.80, CAT_ESP, 3.10, "HP-SH-5003-L", 1290),
    ("MAN-78-V2-NEG-001", "Manillar Moto Universal 7/8 22mm Alto Negro Antideslizante",
     5, 2.70, CAT_MAN, 2.46, "HP-CB0381", 1190),
    ("MAN-78-V2-PLA-001", "Manillar Moto Universal 7/8 22mm Alto Plateado Antideslizante",
     5, 2.70, CAT_MAN, 2.46, "HP-CB0381", 1190),
    ("MAN-78-V3-PLA-001", "Manillar Café Racer Universal 7/8 22mm Recto Plateado Cromado",
     5, 3.00, CAT_MAN, 2.46, "HP-CB0381", 1190),
]

EXT_SKUS = [
    ("EXT-ESP-8F-8F-001",   "Extensor Espejo Moto Rosca 8mm Int/Ext Horario Universal"),
    ("EXT-ESP-8F-8R-001",   "Extensor Espejo Moto Rosca 8mm Int Hor / Ext Antihor"),
    ("EXT-ESP-8R-8F-001",   "Extensor Espejo Moto Rosca 8mm Int Antihor / Ext Hor"),
    ("EXT-ESP-8R-8R-001",   "Extensor Espejo Moto Rosca 8mm Int/Ext Antihorario Univ"),
    ("EXT-ESP-8F-10F-001",  "Extensor Espejo Moto Rosca 8mm Int Hor / 10mm Ext Hor"),
    ("EXT-ESP-8R-10F-001",  "Extensor Espejo Moto Rosca 8mm Int Antihor / 10mm Ext"),
    ("EXT-ESP-8F-10R-001",  "Extensor Espejo Moto Rosca 8mm Int Hor / 10mm Ext Antihor"),
    ("EXT-ESP-8R-10R-001",  "Extensor Espejo Moto Rosca 8mm Int/10mm Ext Antihorario"),
    ("EXT-ESP-10F-10F-001", "Extensor Espejo Moto Rosca 10mm Int/Ext Horario Universal"),
    ("EXT-ESP-10R-10F-001", "Extensor Espejo Moto Rosca 10mm Int Antihor / Ext Hor"),
    ("EXT-ESP-10F-10R-001", "Extensor Espejo Moto Rosca 10mm Int Hor / Ext Antihor"),
    ("EXT-ESP-10R-10R-001", "Extensor Espejo Moto Rosca 10mm Int/Ext Antihorario Univ"),
    ("EXT-ESP-10F-8F-001",  "Extensor Espejo Moto Rosca 10mm Int Hor / 8mm Ext Hor"),
    ("EXT-ESP-10F-8R-001",  "Extensor Espejo Moto Rosca 10mm Int Hor / 8mm Ext Antihor"),
    ("EXT-ESP-10R-8F-001",  "Extensor Espejo Moto Rosca 10mm Int Antihor / 8mm Ext"),
    ("EXT-ESP-10R-8R-001",  "Extensor Espejo Moto Rosca 10mm Int/8mm Ext Antihorario"),
]
for sku, nombre in EXT_SKUS:
    ITEMS.append((sku, nombre, 10, 0.12, CAT_EXT, 20.0, None, None))

assert len(ITEMS) == 22, len(ITEMS)

# ── Descripciones ─────────────────────────────────────────────────────────────
def descripcion(sku, nombre, grupo):
    if grupo == CAT_SOP:
        anclaje = "al manillar" if "MAN" in sku else "a la base del espejo"
        return (
            f"Soporte universal para celular apto para moto, con anclaje {anclaje}.\n\n"
            "- Sujeción ajustable: se adapta a celulares de 4,7\" a 7\".\n"
            "- Rotación 360°: podés usarlo en vertical u horizontal.\n"
            "- Construcción en ABS reforzado con gomas antivibración.\n"
            "- Instalación sin herramientas especiales.\n\n"
            "Producto nuevo. Envíos a todo el país."
        )
    if grupo == CAT_ESP:
        return (
            "Par de espejos de puño circulares para moto, universales.\n\n"
            "- Montaje en manillar de 7/8\" (22mm).\n"
            "- Cuerpo de aluminio con terminación negra.\n"
            "- Brazo y cabezal regulables para ajustar el ángulo de visión.\n"
            "- Se venden por par (izquierdo y derecho).\n\n"
            "Producto nuevo. Envíos a todo el país."
        )
    if grupo == CAT_MAN:
        color = "negro" if "NEG" in sku else "plateado cromado"
        tipo = ("Manillar tipo Café Racer, recto" if "V3" in sku
                else "Manillar alto con superficie antideslizante")
        return (
            f"{tipo}, universal para moto, en {color}.\n\n"
            "- Medida universal 7/8\" (22mm) de diámetro.\n"
            "- Aluminio de alta resistencia.\n"
            "- Compatible con puños, espejos y comandos estándar.\n"
            "- Se vende por unidad.\n\n"
            "Producto nuevo. Envíos a todo el país."
        )
    interior, exterior = ext_desc(sku)
    return (
        "Extensor / adaptador de rosca para espejo de moto.\n\n"
        f"- Rosca interior: {interior}.\n"
        f"- Rosca exterior: {exterior}.\n"
        "- Permite montar espejos con rosca distinta a la del soporte original "
        "y ganar altura para mejorar el campo de visión.\n"
        "- Acero con terminación negra.\n"
        "- Se vende por unidad.\n\n"
        "Producto nuevo. Envíos a todo el país."
    )

# Títulos acortados: Mercado Libre corta en 60 caracteres y estos dos se pasaban.
# El nombre original de la importación queda como comentario en la celda.
TITULO_ML = {
    "MAN-78-V2-PLA-001": "Manillar Moto Universal 7/8 22mm Alto Plateado",
    "MAN-78-V3-PLA-001": "Manillar Café Racer Universal 7/8 22mm Recto Cromado",
}

CATEGORIA_ML = {
    CAT_SOP: "Accesorios para Vehículos > Acc. para Motos y Cuatriciclos > Soportes y Bases",
    CAT_ESP: "Accesorios para Vehículos > Acc. para Motos y Cuatriciclos > Espejos",
    CAT_EXT: "Accesorios para Vehículos > Acc. para Motos y Cuatriciclos > Espejos",
    CAT_MAN: "Accesorios para Vehículos > Acc. para Motos y Cuatriciclos > Manubrios",
}

wb = Workbook()

# ═══════════════════════════════════════════════════════════════════════════════
# Hoja 1 — Instrucciones
# ═══════════════════════════════════════════════════════════════════════════════
ws = wb.active
ws.title = "Instrucciones"
ws.sheet_view.showGridLines = False
ws.column_dimensions["A"].width = 3
ws.column_dimensions["B"].width = 112

def line(row, text, font=NEGRO, fill=None):
    c = ws.cell(row=row, column=2, value=text)
    c.font = font
    c.alignment = WRAP
    if fill:
        c.fill = fill
    return c

line(2, "Carga masiva a Mercado Libre — productos nuevos de la PI10196", H1)
line(3, "Importación IMP1780969938902 · orden 21/05/2026 · recibida 12/09/2026 · 33 ítems, "
        "22 de ellos sin publicación previa.", MUTED)

line(5, "Qué contiene este archivo", H2)
line(6, "• Publicaciones — una fila por SKU nuevo, con todos los campos que pide el cargador "
        "masivo de Mercado Libre. Es la hoja que copiás a la plantilla de ML.")
line(7, "• Costos PI10196 — el costo real de cada SKU con el prorrateo de la importación "
        "aplicado, y el precio sugerido que alimenta la columna Precio de la hoja Publicaciones.")
line(8, "• Parametros — los tres supuestos que mueven todos los números. Editalos ahí y el "
        "resto se recalcula solo.")

line(10, "Antes de subir: dos cosas bloquean la carga", H2)
line(11, "1. FOTOS. Mercado Libre rechaza cualquier publicación sin al menos una imagen. La "
         "columna Fotos está vacía y marcada en amarillo. Hay que completarla antes de subir.",
     NEGRO, YELLOW)
line(12, "2. PRECIO. Los 22 SKUs no tenían precio de venta definido. La columna Precio trae un "
         "valor calculado a partir del costo real × un markup de referencia tomado de productos "
         "similares de tu propio catálogo. Es un placeholder para que la fila sea válida, no un "
         "precio decidido. Por eso todas las filas van con Estado inicial = pausado.",
     NEGRO, YELLOW)

line(14, "Cómo se usa", H2)
line(15, "1. Completá la columna Fotos (una o más URLs separadas por coma) y revisá Precio.")
line(16, "2. En Mercado Libre: Mis publicaciones → Publicar → Carga masiva. El cargador pide "
         "elegir la categoría primero y recién ahí te da la plantilla .xlsx de esa categoría.")
line(17, "3. Los 22 SKUs caen en 4 categorías distintas, así que son 4 plantillas. La columna "
         "Categoría destino de la hoja Publicaciones ya te dice cuál va con cuál.")
line(18, "4. Copiá las filas del grupo correspondiente a cada plantilla de ML, campo por campo. "
         "Los nombres de columna de ML varían por categoría; los de acá están puestos con el "
         "nombre que usa ML en la mayoría de las plantillas de accesorios para motos.")
line(19, "5. Subí cada plantilla. Quedan pausadas: revisás precio y foto en ML y recién ahí las "
         "activás.")
line(20, "6. Cuando estén publicadas, pasame los MLU de cada SKU y los cargo en la tabla "
         "productos para que el sync de stock los tome.")

line(22, "Dos cosas a tener en cuenta", H2)
line(23, "• El stock de estos 22 SKUs nunca entró al sistema. Cuando la PI10196 se marcó como "
         "recibida, applyImportArrival() sumó stock sólo a los 11 SKUs que ya existían en la "
         "tabla productos; los otros 22 se reportaron como noEncontrados y se saltearon. Son 385 "
         "unidades sin registrar. Hay que dar de alta los productos para que el stock exista.")
line(24, "• Los títulos salen del nombre cargado en la importación. Dos se pasaban de los 60 "
         "caracteres que permite ML (MAN-78-V2-PLA-001 y MAN-78-V3-PLA-001) y los acorté; el "
         "nombre original quedó como comentario en la celda. La columna Largo título se pinta de "
         "rojo sola si al editar alguno te pasás de 60.")

line(26, "Leyenda de colores", H2)
line(27, "Amarillo = lo tenés que completar o revisar vos.", NEGRO, YELLOW)
c = line(28, "Azul = dato cargado a mano (viene de la importación o de tu catálogo).")
c.font = AZUL
c = line(29, "Verde = traído de otra hoja de este mismo archivo.")
c.font = VERDE
line(30, "Negro = calculado por fórmula.")

# ═══════════════════════════════════════════════════════════════════════════════
# Hoja 2 — Parametros
# ═══════════════════════════════════════════════════════════════════════════════
wp = wb.create_sheet("Parametros")
wp.sheet_view.showGridLines = False
wp.column_dimensions["A"].width = 3
wp.column_dimensions["B"].width = 52
wp.column_dimensions["C"].width = 16
wp.column_dimensions["D"].width = 60

wp["B2"] = "Parámetros de la PI10196"
wp["B2"].font = H1

for col, head in (("B", "Concepto"), ("C", "Valor"), ("D", "De dónde sale")):
    c = wp[f"{col}4"]
    c.value = head
    c.font = HDRF
    c.fill = HDRFILL
    c.border = BOX

params = [
    (5, "Total pagado por la importación (USD)", 1467.00, AZUL, "$#,##0.00",
     "Campo total del registro IMP1780969938902 en Supabase. Incluye mercadería, "
     "traslado interno (USD 12,80), nacionalización (USD 810) e IVA."),
    (6, "Costo declarado de los 33 ítems (USD)", 685.20, AZUL, "$#,##0.00",
     "Suma de qty × costo de los 33 ítems de la importación. Son los 33, no sólo los 22 "
     "nuevos: el prorrateo reparte los gastos sobre toda la carga."),
    (7, "Factor de prorrateo", "=C5/C6", NEGRO, "0.0000",
     "Cuánto multiplica el costo declarado para llegar al costo real puesto en depósito. "
     "Misma fórmula que usa la pantalla de Importaciones."),
    (8, "Tipo de cambio UYU/USD", 42.00, AZUL, "0.00",
     "SUPUESTO. Es el TC implícito en los SKUs de esta misma PI que ya están cargados: "
     "ALERONFINOSNK, HSJ-20121, HS-30006 y los DOM tienen costo = declarado × 90, y "
     "90 / 2,1410 = 42. Cambialo acá si usaste otro."),
    (9, "Precio mínimo de publicación (UYU)", 290.00, AZUL, "$#,##0",
     "SUPUESTO MÍO, revisalo. Piso para que los extensores no queden a $216. "
     "Ningún precio sugerido baja de este valor."),
]

for row, concepto, valor, font, fmt, fuente in params:
    wp.cell(row=row, column=2, value=concepto).font = BOLD
    c = wp.cell(row=row, column=3, value=valor)
    c.font = font
    c.number_format = fmt
    c.alignment = CTR
    if row in (8, 9):
        c.fill = YELLOW
    d = wp.cell(row=row, column=4, value=fuente)
    d.font = MUTED
    d.alignment = WRAP
    for col in (2, 3, 4):
        wp.cell(row=row, column=col).border = BOX
    wp.row_dimensions[row].height = 46

wp["B11"] = ("Los dos valores en amarillo son supuestos míos, no datos de la importación. "
             "Todo lo demás sale del registro de la PI10196.")
wp["B11"].font = MUTED
wp.merge_cells("B11:D11")

# ═══════════════════════════════════════════════════════════════════════════════
# Hoja 3 — Costos PI10196
# ═══════════════════════════════════════════════════════════════════════════════
wc = wb.create_sheet("Costos PI10196")
wc.sheet_view.showGridLines = False

cost_cols = [
    ("A", "SKU", 22),
    ("B", "Producto", 46),
    ("C", "Categoría destino", 22),
    ("D", "Cantidad recibida", 11),
    ("E", "Costo declarado USD", 12),
    ("F", "Costo declarado total USD", 13),
    ("G", "Costo real USD", 11),
    ("H", "Costo real UYU", 12),
    ("I", "Markup", 9),
    ("J", "Precio calculado", 12),
    ("K", "Precio sugerido", 12),
    ("L", "Comparable en tu catálogo", 26),
]
for col, head, width in cost_cols:
    wc.column_dimensions[col].width = width

wc["A1"] = "Costo real por SKU — productos nuevos de la PI10196"
wc["A1"].font = H1
wc["A2"] = ("Costo real = costo declarado × factor de prorrateo × tipo de cambio. "
            "El markup es editable: cambialo y el precio sugerido se recalcula.")
wc["A2"].font = MUTED

HDR_ROW = 4
for col, head, _ in cost_cols:
    c = wc[f"{col}{HDR_ROW}"]
    c.value = head
    c.font = HDRF
    c.fill = HDRFILL
    c.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")
    c.border = BOX
wc.row_dimensions[HDR_ROW].height = 32

first = HDR_ROW + 1
for i, (sku, nombre, qty, costo, grupo, markup, comp_sku, comp_precio) in enumerate(ITEMS):
    r = first + i
    wc.cell(row=r, column=1, value=sku).font = AZUL
    wc.cell(row=r, column=2, value=nombre).font = AZUL
    wc.cell(row=r, column=3, value=grupo).font = AZUL
    wc.cell(row=r, column=4, value=qty).font = AZUL
    wc.cell(row=r, column=5, value=costo).font = AZUL
    wc.cell(row=r, column=6, value=f"=D{r}*E{r}").font = NEGRO
    wc.cell(row=r, column=7, value=f"=E{r}*Parametros!$C$7").font = NEGRO
    wc.cell(row=r, column=8, value=f"=G{r}*Parametros!$C$8").font = NEGRO
    m = wc.cell(row=r, column=9, value=markup)
    m.font = AZUL
    m.fill = YELLOW
    wc.cell(row=r, column=10, value=f"=ROUND(H{r}*I{r},0)").font = NEGRO
    wc.cell(row=r, column=11, value=f"=MAX(J{r},Parametros!$C$9)").font = NEGRO
    comp = f"{comp_sku} — $ {comp_precio:,}".replace(",", ".") if comp_sku else "sin comparable"
    cc = wc.cell(row=r, column=12, value=comp)
    cc.font = AZUL if comp_sku else MUTED

    for col in range(1, 13):
        cell = wc.cell(row=r, column=col)
        cell.border = BOX
        if col in (4,):
            cell.number_format = "#,##0"
            cell.alignment = CTR
        elif col in (5, 6, 7):
            cell.number_format = "$#,##0.0000" if col == 7 else "$#,##0.00"
        elif col == 8:
            cell.number_format = "$#,##0.00"
        elif col == 9:
            cell.number_format = "0.00x"
            cell.alignment = CTR
        elif col in (10, 11):
            cell.number_format = "$#,##0"
        elif col == 2:
            cell.alignment = WRAP

last = first + len(ITEMS) - 1

tot = last + 1
wc.cell(row=tot, column=3, value="TOTAL 22 SKUs nuevos").font = BOLD
wc.cell(row=tot, column=4, value=f"=SUM(D{first}:D{last})").font = BOLD
wc.cell(row=tot, column=6, value=f"=SUM(F{first}:F{last})").font = BOLD
wc.cell(row=tot, column=4).number_format = "#,##0"
wc.cell(row=tot, column=4).alignment = CTR
wc.cell(row=tot, column=6).number_format = "$#,##0.00"
for col in range(1, 13):
    wc.cell(row=tot, column=col).fill = GREYFILL
    wc.cell(row=tot, column=col).border = BOX

nota = tot + 2
wc.cell(row=nota, column=1,
        value="Markups de referencia tomados de tu catálogo: espejos de puño 3,10x "
              "(HP-SH-5003-L), manillares 2,46x (HP-CB0381..85), accesorios de bajo costo "
              "8x–20x (PATENTE1 8,24x, HP-MG072 7,98x, FSB-002 7,17x). Los soportes de celular "
              "y los extensores no tienen comparable directo: ahí el markup es estimado.").font = MUTED
wc.merge_cells(start_row=nota, start_column=1, end_row=nota, end_column=12)
wc.cell(row=nota, column=1).alignment = WRAP
wc.row_dimensions[nota].height = 30

wc.cell(row=nota + 1, column=1,
        value="Los 11 SKUs restantes de la PI10196 (ALERONFINOSNK, CPJ-62001, DOM00..03, "
              "HP-CB0381, HS-30006, HSJ-20121, PUNBLACK, PUNRED) ya están publicados y no "
              "entran en esta planilla.").font = MUTED
wc.merge_cells(start_row=nota + 1, start_column=1, end_row=nota + 1, end_column=12)
wc.cell(row=nota + 1, column=1).alignment = WRAP

wc.freeze_panes = f"A{first}"

# ═══════════════════════════════════════════════════════════════════════════════
# Hoja 4 — Publicaciones
# ═══════════════════════════════════════════════════════════════════════════════
wpub = wb.create_sheet("Publicaciones")
wpub.sheet_view.showGridLines = False

pub_cols = [
    ("A", "Categoría destino", 22),
    ("B", "Categoría sugerida en ML", 40),
    ("C", "Título", 58),
    ("D", "Largo título", 8),
    ("E", "SKU", 22),
    ("F", "Precio", 11),
    ("G", "Moneda", 9),
    ("H", "Stock disponible", 10),
    ("I", "Condición", 11),
    ("J", "Tipo de publicación", 15),
    ("K", "Estado inicial", 11),
    ("L", "Fotos (URLs separadas por coma)", 34),
    ("M", "Marca", 12),
    ("N", "Modelo", 12),
    ("O", "Garantía", 18),
    ("P", "Descripción", 62),
]
for col, head, width in pub_cols:
    wpub.column_dimensions[col].width = width

wpub["A1"] = "Publicaciones a crear — 22 SKUs nuevos de la PI10196"
wpub["A1"].font = H1
wpub["A2"] = ("Completá Fotos (obligatorio para ML) y revisá Precio. Después copiá cada grupo "
              "a la plantilla de carga masiva de su categoría.")
wpub["A2"].font = MUTED

leyenda = ("Columnas en amarillo = las completás vos. La fila 5 es un EJEMPLO del formato "
           "esperado, borrala antes de subir. Precio viene de la hoja Costos PI10196.")
wpub["A3"] = leyenda
wpub["A3"].font = Font(name=F, size=9, bold=True, color="9C6500")

PHDR = 4
for col, head, _ in pub_cols:
    c = wpub[f"{col}{PHDR}"]
    c.value = head
    c.font = HDRF
    c.fill = HDRFILL
    c.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")
    c.border = BOX
wpub.row_dimensions[PHDR].height = 32

# Fila de ejemplo
EJ = PHDR + 1
ejemplo = [
    "EJEMPLO — borrar", "Accesorios para Vehículos > ... > Espejos",
    "Espejo Redondo Moto Universal Rosca 10mm Negro", None, "EJEMPLO-001",
    1290, "UYU", 12, "Nuevo", "Clásica", "pausado",
    "https://midominio.com/fotos/ej-1.jpg, https://midominio.com/fotos/ej-2.jpg",
    "Genérica", "Universal", "Sin garantía",
    "Espejo universal para moto.\n\n- Rosca 10mm.\n- Cuerpo de aluminio.",
]
for idx, val in enumerate(ejemplo, start=1):
    c = wpub.cell(row=EJ, column=idx, value=val)
    c.font = Font(name=F, size=10, italic=True, color="9C6500")
    c.fill = EJFILL
    c.border = BOX
    c.alignment = WRAP
wpub.cell(row=EJ, column=4, value=f"=LEN(C{EJ})").alignment = CTR
wpub.cell(row=EJ, column=6).number_format = "$#,##0"
wpub.row_dimensions[EJ].height = 30

# Filas reales, agrupadas por categoría destino
orden = [CAT_SOP, CAT_ESP, CAT_EXT, CAT_MAN]
items_ordenados = sorted(ITEMS, key=lambda it: (orden.index(it[4]), it[0]))
# fila en la hoja de costos, por SKU
fila_costo = {it[0]: first + i for i, it in enumerate(ITEMS)}

pfirst = EJ + 1
for i, (sku, nombre, qty, costo, grupo, markup, comp_sku, comp_precio) in enumerate(items_ordenados):
    r = pfirst + i
    cr = fila_costo[sku]
    titulo = TITULO_ML.get(sku, nombre)
    vals = [
        (1, grupo, AZUL, None),
        (2, CATEGORIA_ML[grupo], AZUL, None),
        (3, titulo, AZUL, None),
        (4, f"=LEN(C{r})", NEGRO, None),
        (5, sku, AZUL, None),
        (6, f"='Costos PI10196'!K{cr}", VERDE, "$#,##0"),
        (7, "UYU", AZUL, None),
        (8, qty, AZUL, "#,##0"),
        (9, "Nuevo", AZUL, None),
        (10, "Clásica", AZUL, None),
        (11, "pausado", AZUL, None),
        (12, None, NEGRO, None),
        (13, "Genérica", AZUL, None),
        (14, "Universal", AZUL, None),
        (15, "Sin garantía", AZUL, None),
        (16, descripcion(sku, nombre, grupo), AZUL, None),
    ]
    for col, val, font, fmt in vals:
        c = wpub.cell(row=r, column=col, value=val)
        c.font = font
        c.border = BOX
        c.alignment = WRAP
        if fmt:
            c.number_format = fmt
        if col in (4, 8):
            c.alignment = CTR
        if col == 12:
            c.fill = YELLOW
    if sku in TITULO_ML:
        wpub.cell(row=r, column=3).comment = Comment(
            f"Acortado para entrar en los 60 caracteres de ML.\n"
            f"Nombre original en la PI10196:\n{nombre} ({len(nombre)} caracteres).",
            "EcomManager", height=110, width=300)
    wpub.row_dimensions[r].height = 30

plast = pfirst + len(items_ordenados) - 1

wpub.cell(row=plast + 2, column=1,
          value="Largo título: Mercado Libre corta en 60 caracteres. Los que se pasan hay que "
                "acortarlos antes de subir.").font = MUTED
wpub.cell(row=plast + 3, column=1,
          value="Marca / Modelo / Garantía: valores por defecto. Si la plantilla de la categoría "
                "pide atributos adicionales (material, color, tipo de rosca), completalos ahí.").font = MUTED
wpub.cell(row=plast + 4, column=1,
          value="Tipo de publicación: 'Clásica' es el default. Si querés Premium, cambialo antes "
                "de subir — cambia la comisión.").font = MUTED

wpub.freeze_panes = f"A{pfirst}"

# Marca en rojo cualquier título que se pase de los 60 caracteres de ML.
wpub.conditional_formatting.add(
    f"D{EJ}:D{plast}",
    CellIsRule(operator="greaterThan", formula=["60"],
               fill=PatternFill("solid", fgColor="FFC7CE"),
               font=Font(name=F, size=10, bold=True, color="9C0006")))

# Comentario sobre la columna Fotos
wpub[f"L{PHDR}"].comment = Comment(
    "Obligatorio. Mercado Libre rechaza la publicación sin al menos una imagen.\n"
    "Formato: URLs públicas https, separadas por coma. Mínimo 500x500 px, fondo blanco "
    "para la foto principal.", "EcomManager", height=120, width=300)

wpub[f"F{PHDR}"].comment = Comment(
    "Placeholder calculado: costo real × markup de referencia (hoja Costos PI10196).\n"
    "No es un precio decidido. Por eso las filas van pausadas.", "EcomManager",
    height=100, width=300)

wb.save(OUT)
print("OK ->", OUT)
