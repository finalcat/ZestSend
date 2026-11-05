/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/client/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      borderRadius: {
        xl: "var(--zest-radius-control, 0.75rem)",
        "2xl": "var(--zest-radius-card, 1rem)",
        "3xl": "var(--zest-radius-panel, 1.5rem)",
      },
    },
  },
  plugins: [],
};
