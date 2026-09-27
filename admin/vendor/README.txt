Third-party libraries used by the admin portal's exports.

  xlsx.full.min.js              SheetJS 0.18.5  (Apache-2.0)  -> .xlsx export
  jspdf.umd.min.js              jsPDF 2.5.1     (MIT)         -> .pdf export
  jspdf.plugin.autotable.min.js jsPDF-AutoTable 3.8.2 (MIT)   -> PDF tables

They are served from this folder rather than a CDN so that exports keep working
without an internet connection or behind a restrictive network, and so that the
admin pages, which display applicants' ID numbers, make no third-party
requests at all.
