/*
  Runs in <head> before first paint (Next.js "preventing flash before hydration"
  guide): applies the saved theme, else the system preference. Dark is the
  server default because the DeSpell product is dark.
*/
export const THEME_STORAGE_KEY = "despell-lab-theme";

export const themeScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;
