// GENERATED FILE - do not edit. Built by scripts/generate-set-digital.ts from api.scryfall.com/sets.
//
// LOCAL PATCH (Cloudflare port): which sets are PAPER sets and which DIGITAL, by Scryfall's own
// `digital` flag on the set object. `assign_print_counts` reads it: Scryfall's `paperprints` and
// `papersets` count a printing by its set, so an MTGO-only printing in a paper set is a paper
// print. See the generator for the measurements. Committed and refreshed by hand with
// `bun run set-digital`; a set in neither list falls back to the printing's own `games`.
//
// Space separated and sorted; read once per store BUILD, never at query time.

/// 992 set codes.
pub(crate) const PAPER_SETS: &str = "\
    10e 2ed 2x2 2xm 30a 3ed 40k 4bb 4ed 5dn 5ed 6ed 7ed 8ed 9ed a25 aacr aafr ablb abro aclb \
    acmm acr adft admu adsk aecl aeoe aer afc afdn afic afin afr ainr akh akhm ala alci all \
    altc altr amh1 amh2 amh3 amid amkm amom amsh aneo aone aotj apc arb arc arn asnc asos aspm \
    astx atdm ath atla atle atmt atq avow avr awoe aznr bbd bchr bfz big blb blc bng bok bot \
    brb brc bro brr btd c13 c14 c15 c16 c17 c18 c19 c20 c21 cc1 cc2 ced cei chk chr clb clu cm1 \
    cm2 cma cmb1 cmb2 cmd cmm cmr cn2 cns con cp1 cp2 cp3 csp cst dbl dci dd1 dd2 ddc ddd dde \
    ddf ddg ddh ddi ddj ddk ddl ddm ddn ddo ddp ddq ddr dds ddt ddu dft dgm dis dka dkm dmc dmr \
    dmu dom dpa drb drc drk dsc dsk dst dtk dvd e01 e02 ecc ecl eld ema emn eoc eoe eos eve evg \
    exo exp f01 f02 f03 f04 f05 f06 f07 f08 f09 f10 f11 f12 f13 f14 f15 f16 f17 f18 fbb fbro \
    fca fclu fdc fdmu fdn fem ffdn fic fin fj22 fj25 fjmp fltr fmom fmsc fnm fone fra frc frf \
    ftla ftmc fut g00 g01 g02 g03 g04 g05 g06 g07 g08 g09 g10 g11 g17 g18 g99 gdy gk1 gk2 gn2 \
    gn3 gnt gpt grn gs1 gtc gvl h09 h17 h1r h2r hho hml hob hoc hop hou ice iko ima inr inv isd \
    itp j12 j13 j14 j15 j16 j17 j18 j19 j20 j22 j25 jgp jmp jou jp1 jtla jud jvc khc khm kld \
    ktk l12 l13 l14 l15 l16 l17 lcc lci lea leb leg lgn lmar lrw ltc ltr m10 m11 m12 m13 m14 \
    m15 m19 m20 m21 m3c macr mafr mar mat mb2 mbc mbro mbs mclb md1 mdmu med mgb mh1 mh2 mh3 \
    mic mid mir mkc mkhm mkm mltr mm2 mm3 mma mmh2 mmid mmq mneo moc mom mone mor mp2 mpr mps \
    mrd msc msh msnc mstx mul mvow mznr ncc nec nem neo nph o90p oafc oafr oarc oc13 oc14 oc15 \
    oc16 oc17 oc18 oc19 oc20 oc21 oclb ocm1 ocmd ody oe01 ogw ohop olep olgc omic onc one ons \
    opc2 opca ori otc otj otp ovnt ovoc p02 p03 p04 p05 p06 p07 p08 p09 p10 p10e p11 p15a p22 \
    p23 p2hg p30a p30h p30m p30t p5dn p8ed p9ed paer pafr pakh pal00 pal01 pal02 pal03 pal04 \
    pal05 pal06 pal99 pala palp papc parb parl pavr pbbd pbfz pbig pblb pbng pbok pbro pc2 pca \
    pcbb pcel pchk pclb pcmd pcmp pcmr pcns pcon pcsp pcy pd2 pd3 pdft pdgm pdis pdka pdmu pdom \
    pdp10 pdp12 pdp13 pdp14 pdp15 pdrc pdsk pdst pdtk pdtp pecl peld pelp pemn peoe peve pewk \
    pexo pf19 pf20 pf23 pf24 pf25 pf26 pf27 pfdn pfin pfra pfrf pfut pgpt pgpx pgrn pgru pgtc \
    ph17 ph18 ph19 ph20 ph21 ph22 ph23 phel phop phou phpr phtr phuk pidw piko pinv pip pisd \
    pj21 pjas pjjt pjou pjsc pjse pjud pkhm pkld pktk pl21 pl22 pl23 pl24 pl25 pl26 plc plci \
    plg20 plg21 plg22 plg24 plg25 plgm plgn plny plrw pls plst pltc pltr pm10 pm11 pm12 pm13 \
    pm14 pm15 pm19 pm20 pm21 pmat pmbs pmda pmei pmh1 pmh2 pmh3 pmic pmid pmkm pmmq pmom pmor \
    pmps pmps06 pmps07 pmps08 pmps09 pmps10 pmps11 pmrd pnat pncc pnem pneo pnph pody pogw pone \
    pons por pori potj ppc1 ppcy pplc ppls ppp1 ppro pptk pr2 pr23 prav prcq pred prix prna \
    proe prtr prw2 prwk ps11 ps14 ps15 ps16 ps17 ps18 ps19 psal pscg psdc pshm psnc psoi psok \
    psom psos pspl pspm pss1 pss2 pss3 pss4 pss5 pssc psth pstx psus psvc ptbro ptc ptdm ptdmu \
    ptg pthb pths ptk ptkdf ptla ptmp ptor ptsnc ptsp ptsr puds pulg puma punh punk purl pusg \
    pust pvan pvow pw11 pw12 pw21 pw22 pw23 pw24 pw25 pw26 pwar pwcs pwoe pwor pwos pwwk pxln \
    pxtc pza pzen pznr q06 q07 rav ren rex rfin rin rix rna roe rqs rtr rvr s00 s99 sbro scd \
    scg sch sds shm skhm slc slci sld slp slu slx slz smh3 smid smom snc sneo soa soc soi sok \
    som sos spe spg spm ss1 ss2 ss3 sstx sta sth stx sum sunf svow sznr t10e t2x2 t2xm t30a \
    t40k ta25 tacr taer tafc tafr takh tala tarb tavr tbbd tbfz tbig tblb tblc tbng tbot tbrc \
    tbro tbth tc14 tc15 tc16 tc17 tc18 tc19 tc20 tc21 tclb tcm2 tcma tcmm tcmr tcn2 tcns tcon \
    tdag tdc tdd1 tdd2 tddc tddd tdde tddf tddg tddh tddi tddj tddk tddl tddm tdds tddt tddu \
    tdft tdgm tdka tdm tdmc tdmr tdmu tdom tdrc tdsc tdsk tdtk tdvd te01 tecc tecl teld tema \
    temn teoc teoe teve tevg tfdc tfdn tfic tfin tfra tfrc tfrf tfth tgk1 tgk2 tgn2 tgn3 tgrn \
    tgtc tgvl thb thob thou thp1 thp2 thp3 ths tiko tima tinr tisd tjou tjvc tkhc tkhm tkld \
    tktk tla tlcc tlci tle tlrw tltc tltr tm10 tm11 tm12 tm13 tm14 tm15 tm19 tm20 tm21 tm3c \
    tmbs tmc tmd1 tmed tmh1 tmh2 tmh3 tmic tmid tmkc tmkm tmm2 tmm3 tmma tmoc tmom tmor tmp \
    tmsc tmsh tmt tmul tncc tnec tneo tnph togw tonc tone tor tori totc totj totp tpca tpip trc \
    trex trix trk trna troe trtr trvr tsb tscd tshm tsnc tsoc tsoi tsom tsos tsp tspm tsr tstx \
    ttdc ttdm tthb tths ttla ttle ttmc ttmt ttrk ttsr tugl tuma tund tunf tust tvoc tvow twar \
    twho twoc twoe twwk txln tzen tznc tznr uds ugin ugl ulg ulst uma und unf unh unk usg ust \
    v09 v10 v11 v12 v13 v14 v15 v16 v17 vis voc vow w16 w17 war wc00 wc01 wc02 wc03 wc04 wc97 \
    wc98 wc99 wdmu wfin who wmc wmkm wmom woc woe wone wot wth wwk wwoe xln zen znc zne znr";

/// 61 set codes.
pub(crate) const DIGITAL_SETS: &str = "\
    aa1 aa2 aa3 aa4 ajmp akr ana anb ea1 ea2 ea3 ha1 ha2 ha3 ha4 ha5 ha6 ha7 hbg j21 klr me1 \
    me2 me3 me4 oana om1 omb pa1 pana past pio pmoa prm psdg pz1 pz2 sir sis td0 td2 tpr vma \
    xana yblb ybro ydft ydmu ydsk yecl yeoe ylci ymid ymkm yneo yone yotj ysnc ysos ytdm ywoe";
