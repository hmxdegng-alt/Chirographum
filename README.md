<p align="center"><img src="assets/readme-logo.png" width="120" alt="Chirographum"></p>

# Chirographum

Editor de texto que escribe e imprime con **tu propia letra**. La meta: enseñar una hoja impresa y que te digan «sí, esto lo has escrito tú».

*A text editor that writes and prints in your own handwriting. Free and open source (AGPL-3.0). Interface in Spanish until version 1.0.*

## Estado: Fase 0 · prueba de realismo

Esta versión sirve para comprobar si el resultado engaña antes de construir el editor completo. Permite:

- **Tu letra:** dibujar con el ratón, el trackpad o un lápiz digital cada letra de una frase de prueba, varias veces. Incluye guías, letra de referencia, suavizado contra el temblor y presión simulada por la velocidad.
- **Hoja:** escribir un texto en A4 con tu letra, con boli de gel, bola o lápiz HB, y con imperfecciones ajustables: tamaño, rotación, inclinación, líneas que se tuercen, margen que se desplaza, letra que encoge al llegar al borde y textura de la tinta.
- **Imprimir o exportar a PDF** a tamaño real (A4, 600 ppp).
- **Guardar y abrir tu mano** como archivo `.chmano`.

## Descargar e instalar (Windows)

1. Entra en [Releases](../../releases) y descarga `Chirographum-Setup-x.y.z.exe`.
2. Ábrelo. Windows avisará de «aplicación no reconocida» porque el programa no tiene firma digital (es de pago): pulsa **Más información** y después **Ejecutar de todas formas**.
3. Sigue el instalador.

Las actualizaciones se instalan igual: descargando el instalador nuevo.

## Cómo hacer la prueba de realismo

1. En **Tu letra**, deja la frase de prueba o escribe otra, y dibuja cada letra 3 veces. Pulsa **Intro** para guardar cada dibujo.
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
