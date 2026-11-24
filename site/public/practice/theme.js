/* Practice pages wear the student's Class Live theme. The feed page saves the
   colors it just applied; this reads them before the page paints. */
(function(){
  try{
    var v=JSON.parse(localStorage.getItem('cl_theme_vars')||'null');
    if(!v||!v.bg)return;
    var s=document.documentElement.style,set=function(k,x){if(x)s.setProperty('--'+k,x);};
    var dark=!!v.dark;
    set('bg',v.bg);set('panel',v.card);set('text',v.ink);set('muted',v.mut);
    set('line',v.ink);set('soft',v.line);set('mark',v.lnk);
    set('faint','color-mix(in srgb,'+v.ink+' 55%,'+v.card+')');
    set('soft2','color-mix(in srgb,'+v.line+' 40%,'+v.card+')');
    var good=dark?'#7FE3A1':'#0a6b34',bad=dark?'#FF9C94':'#b00018',note=dark?'#F2C46B':'#7a4c00',blue=dark?'#8DB8FF':'#0b4fa8';
    set('good',good);set('bad',bad);set('note',note);set('blue',blue);
    var mix=function(c,p){return 'color-mix(in srgb,'+c+' '+p+'%,'+v.card+')';};
    set('badbg',mix(bad,14));set('badln',mix(bad,45));set('goodbg',mix(good,14));
    set('warnbg',mix(note,14));set('warnln',mix(note,40));set('bluebg',mix(blue,14));set('blueln',mix(blue,40));
    s.colorScheme=dark?'dark':'light';
  }catch(e){}
})();
