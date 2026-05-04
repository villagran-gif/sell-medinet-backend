#!/usr/bin/env python3
"""CRM View Settings ID 5 (CRM Task list) actualizada con columnas:
title, reference_docname (Deal), status, assigned_to, due_date, priority, modified.
public=1, is_default=1. order_by due_date desc."""

# UPDATE 2026-05-04:
# - Translation override 'Leads' → 'Leads' (es) para que sidebar muestre "Leads"
#   en vez de "Clientes potenciales".
# - Form Script `task_deal_clickable`: hace que cualquier celda con texto
#   "CRM-DEAL-YYYY-NNNNN" en la list view de tasks sea un link al deal
#   (regex match + onclick navigate). Plus column type cambiado a Link.
