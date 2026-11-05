/** Token semantik (RANCANGAN §10.3): warna komponen TIDAK PERNAH hex langsung,
 * selalu variabel CSS di src/index.css agar light/dark konsisten. */
const token = (name) => `rgb(var(--color-${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: token("bg"),
        surface: token("surface"),
        elevated: token("elevated"),
        ink: token("text"),
        muted: token("text-muted"),
        line: token("border"),
        accent: token("accent"),
        success: token("success"),
        warning: token("warning"),
        danger: token("danger"),
      },
    },
  },
  plugins: [],
};
