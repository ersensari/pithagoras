(function () {
        try {
          // Copy prior browser preferences and drafts once; retain old values for rollback.
          [localStorage, sessionStorage].forEach(function (store) {
            Object.keys(store).forEach(function (key) {
              if (key.indexOf("pithagoras.") !== 0) return;
              var next = "yulify." + key.slice("pithagoras.".length);
              if (store.getItem(next) === null) store.setItem(next, store.getItem(key));
            });
          });
          var t = localStorage.getItem("yulify.theme") || "system";
          var dark =
            t === "dark" ||
            (t === "system" && !matchMedia("(prefers-color-scheme: light)").matches);
          document.documentElement.dataset.theme = dark ? "dark" : "light";
          // The installed app's title bar, in --canvas from index.css. The tag
          // starts out dark.
          var meta = document.querySelector('meta[name="theme-color"]');
          if (meta && !dark) meta.content = "#fafafb";
          var bar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
          if (bar && !dark) bar.content = "default";
        } catch (e) {
          document.documentElement.dataset.theme = "dark";
        }
      })();
