#!/usr/bin/env python3
"""
Crea CRM Form Script que oculta el boton 'Columnas' de la list view
de CRM Deal via inyeccion de CSS+JS.
"""
import os, json, urllib.request, urllib.parse, sys

SITE=os.environ.get("FRAPPE_CLOUD_SITE_URL","").rstrip("/")
KEY=os.environ.get("FRAPPE_CLOUD_API_KEY","")
SECRET=os.environ.get("FRAPPE_CLOUD_API_SECRET","")
AUTH=f"token {KEY}:{SECRET}"

SCRIPT = """// Hide Columnas button in CRM Deal list view
(function(){
  if (document.getElementById("hide-column-picker-style")) return;
  var s = document.createElement("style");
  s.id = "hide-column-picker-style";
  s.textContent = 'button[data-test="columns-button"], button[aria-label="Columns"], button[aria-label="Columnas"] { display: none !important; }';
  document.head.appendChild(s);
  var hideByText = function(){
    document.querySelectorAll("button").forEach(function(b){
      if (/^\\s*Columnas?\\s*$/.test(b.textContent)) b.style.display = "none";
    });
  };
  hideByText();
  new MutationObserver(hideByText).observe(document.body, {childList:true, subtree:true});
})();
"""

doc = {"doctype":"CRM Form Script","name":"hide_column_picker_deal",
       "dt":"CRM Deal","view":"List","enabled":1,"script":SCRIPT}
body = json.dumps({"doc":doc}).encode()
req = urllib.request.Request(f"{SITE}/api/method/frappe.client.insert",
    data=body, method="POST",
    headers={"Authorization":AUTH,"Content-Type":"application/json"})
try:
    r = urllib.request.urlopen(req,timeout=30)
    print(f"OK: {r.status}")
except urllib.error.HTTPError as e:
    if "DuplicateEntry" in e.read().decode("utf-8",errors="replace"):
        # Update instead
        req2 = urllib.request.Request(f"{SITE}/api/resource/CRM%20Form%20Script/hide_column_picker_deal",
            data=json.dumps({"script":SCRIPT,"enabled":1}).encode(), method="PUT",
            headers={"Authorization":AUTH,"Content-Type":"application/json"})
        r2 = urllib.request.urlopen(req2,timeout=30)
        print(f"Updated: {r2.status}")
    else:
        print(f"ERR: {e.code}")
