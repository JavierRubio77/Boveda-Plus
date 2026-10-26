# Bóveda

PWA local-first para guardar contraseñas. No utiliza Supabase ni ningún backend: la bóveda se cifra con Web Crypto y se guarda en IndexedDB del navegador.

## Arrancar en local

```powershell
pnpm install
pnpm dev --host 0.0.0.0 --port 4179
```

Después abre `http://127.0.0.1:4179/` en el ordenador o desde el móvil conectado a la misma red usando la IP local del ordenador.

Para ver las propuestas de icono abre `http://127.0.0.1:4179/icon-proposals.html`.

## Funciones incluidas

- Bóveda cifrada local con clave maestra.
- Entradas con sitio, URL, usuario, contraseña, código adicional y notas.
- Contraseñas ocultas, revelado temporal y copia al portapapeles.
- Generador de contraseñas.
- Lista con navegación alfabética y categorías en mosaico, incluida «Sin categoría». Todos los campos de las entradas son opcionales.
- Descarga de la plantilla oficial e importación local de contraseñas desde Excel; las entradas se añaden y cifran en este dispositivo.
- Aviso de cambio de contraseña a partir de 90 días.
- Alertas en el icono de la cabecera: rojo neón cuando hay recordatorios pendientes. Permiten renovar o aplazar 90 días sin alterar la fecha del último cambio; se pueden desactivar por contraseña desde el editor. Se calculan al abrir/desbloquear y mientras la app está abierta. Las preferencias y los aplazamientos se guardan dentro de la bóveda cifrada y sus copias; las entradas antiguas tienen las alertas activadas por defecto.
- Exportación e importación de copias cifradas.
- Cambio de clave maestra.
- Service Worker y funcionamiento offline tras la primera carga.

El primer arranque pide crear la clave maestra. Un PIN de cuatro dígitos es cómodo, pero una frase más larga protege mejor el archivo exportado.

Al desbloquear datos antiguos o importar una copia cifrada, se retiran únicamente `type` y `favorite` de cada entrada y se guarda el resultado cifrado. Se conservan el resto de campos y las claves de cifrado. Las plantillas Excel anteriores también se admiten: sus columnas retiradas se ignoran.

Validación: `pnpm test` comprueba la migración cifrada, la conservación de datos, las plantillas nuevas y antiguas y los campos opcionales; `pnpm build` genera la PWA. `node tests/browser.cjs` requiere Playwright y Edge instalados (WebKit y Firefox se prueban si están disponibles), y comprueba la compilación de `dist` en tamaños móvil y escritorio sin usar datos reales. El teclado y el autorrelleno deben comprobarse también en iOS real.

La instalación offline guarda juntos el HTML, su JavaScript y su CSS antes de activar la actualización. Cada compilación recibe una caché propia; una descarga incompleta conserva la versión anterior. Esto no borra ni modifica IndexedDB. El arranque muestra un aviso recuperable si no se puede cargar el código. `node tests/pwa.cjs` reproduce la reapertura sin conexión tras vaciar la caché HTTP, la actualización desde v5, una descarga interrumpida y el desbloqueo posterior de una entrada cifrada de prueba.

`node tests/alerts-browser.cjs` comprueba el ciclo de alertas con fechas simuladas: vencimientos a 90, 180 y 270 días, persistencia del aplazamiento y la desactivación tras recargar, renovación real de la contraseña y conservación de borradores al abrir y cerrar la modal.
