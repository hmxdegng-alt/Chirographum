<p align="center"><img src="assets/readme-logo.png" width="120" alt="Chirographum"></p>

# Chirographum

Editor de texto que escribe e imprime con **tu propia letra**. La meta: enseñar una hoja impresa y que te digan «sí, esto lo has escrito tú».

*A text editor that writes and prints in your own handwriting. Free and open source (AGPL-3.0). Interface in Spanish until version 1.0.*

## Estado: Fase 2 en marcha · versión de prueba

- **Tu letra:** dibuja con el ratón, el trackpad o un lápiz digital cada letra varias veces. Cada letra aparece en varios huecos con una letra fantasma de guía; pulsa **Intro** para guardarlos todos. Con **Ctrl + rueda** haces zoom.
- **Hoja:** haz clic en la hoja y escribe directamente, como en un procesador de textos: cursor, selección con el ratón, flechas, Inicio/Fin, copiar, pegar y deshacer. Cuando una página se llena, el texto sigue en la siguiente. Cada letra conserva su dibujo mientras escribes alrededor (si te gusta el efecto de «letras vivas», actívalo en *Ver › Animaciones mientras se escribe*).
- **Formato, como en un procesador de textos** (barra de herramientas, menú *Formato* y atajos): estilos Texto normal, Título, Subtítulo y Encabezados 1 a 3; negrita (la letra repasada), cursiva (más inclinada), subrayado y tachado dibujados a mano, resaltado con fosforito de cinco colores (que arrastra un poco la tinta, como el de verdad), tachones y alineación a la izquierda, centro o derecha. Deshacer y rehacer incluyen el formato.
- **Instrumento, color y tamaño** se eligen en la barra de herramientas para lo seleccionado o para lo que vas a escribir. Los estilos de párrafo (título, encabezados) y la alineación van por párrafo, como en Word o Google Docs.
- **Tachones** como los de verdad: rayajos, rayas, ida y vuelta, cruz o bucles, palabra por palabra o de un tirón, con el grosor y la rabia que quieras (menú ▾ junto al botón del tachón).
- **Regla** sobre la hoja con los márgenes izquierdo y derecho arrastrables.
- **Papel:** folio en blanco, rayado, cuadrícula de 4 y 5 mm o punteado, con margen rojo opcional; el texto se apoya en las rayas. Las líneas se imprimen o, si escribes sobre un cuaderno real, solo se ven en pantalla.
- **Instrumentos:** gel 0,7 y 0,5, bola, rotulador fino y mediano (la tinta se oscurece al cruzarse, como en la realidad), lápiz HB, lápiz 3H y portaminas. Ajustados con escaneos de escritura real.
- **Naturalidad:** tamaño, rotación, inclinación, líneas que se tuercen o suben, margen que se desplaza, letra que encoge al llegar al borde, textura de la tinta y boli que falla. Presets *Cuidadoso*, *Normal* y *Con prisa*, un botón **Aleatorio** y un deslizador que sube o baja todas las imperfecciones a la vez (los ajustes de cada una están en *Ajustes avanzados*).
- **Panel de ajustes** por secciones plegables, con buscador; se puede esconder con el botón de la derecha de la barra o en *Ver › Panel de ajustes*. Cada deslizador tiene un botón ↺ para volver a su valor por defecto y cada sección un botón **Restablecer**.
- **Vista impresa** (botón sobre la hoja o menú *Ver*): imita cómo deja la tinta una impresora de chorro, calibrada con el escaneo de una hoja impresa.
- **Imprimir o exportar a PDF** a tamaño real (A4, 600 ppp), todas las páginas.
- **Documentos** `.chiro` (menú *Archivo*): nuevo, abrir, guardar y guardar como (Ctrl+N, Ctrl+O, Ctrl+S, Ctrl+Mayús+S). Guardan el texto, el dibujo exacto de cada letra y todos los ajustes de la hoja; se escriben con la mano que tengas cargada. Si cierras con cambios sin guardar, el programa te pregunta. Doble clic en un `.chiro` lo abre.
- **Guardar y abrir tu mano** como archivo `.chmano`.

## Descargar e instalar (Windows)

1. Entra en [Releases](../../releases) y descarga `Chirographum-Setup-x.y.z.exe`.
2. Ábrelo. Windows avisará de «aplicación no reconocida» porque el programa no tiene firma digital (es de pago): pulsa **Más información** y después **Ejecutar de todas formas**.
3. Sigue el instalador.

Las actualizaciones se instalan igual: descargando el instalador nuevo. Tus letras, textos y ajustes se guardan en `%APPDATA%\Chirographum` y se conservan al actualizar. Al desinstalar, una casilla te deja borrarlos también (viene sin marcar).

## Cómo hacer la prueba de realismo

1. En **Tu letra**, deja la frase de prueba o escribe otra. Cada letra aparece en varios huecos con una letra fantasma de guía: dibújala en todos y pulsa **Intro** para guardarlos de una vez. Con **Ctrl + rueda** haces zoom.
2. Pasa a **Hoja**, escribe un texto con esas letras y elige el boli que usas normalmente.
3. Pulsa **Imprimir…**, elige A4 y escala 100 % (sin «ajustar a página»). Mejor con impresora de tinta: el tóner láser brilla.
4. Escribe la misma frase a mano con tu boli y compara las dos hojas.

## Privacidad

Chirographum **no se conecta a internet ni a ninguna red en ningún momento**: ni actualizaciones automáticas, ni estadísticas, ni descargas. Tu mano se guarda solo en tu ordenador.

## Para desarrolladores

Requiere Node.js 22.

```bash
npm install
npm run dev      # abre el programa con recarga automática
npm test         # pruebas del motor
npm run dist     # construye el instalador de Windows en release/
```

El código y los comentarios están en inglés; los textos de la interfaz, en `src/i18n/es.ts`.

## Licencia

[GNU Affero General Public License v3.0](LICENSE). Cualquier copia, modificación o plugin debe seguir siendo libre y de código abierto con la misma licencia.

El logo es la letra «ß» de [EB Garamond](https://github.com/georgd/EB-Garamond), con licencia SIL Open Font License.
