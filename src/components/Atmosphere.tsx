export default function Atmosphere() {
  return (
    <>
      <div className="bg-grid" aria-hidden />
      <div className="grain" aria-hidden />
      <div className="scanline-overlay" aria-hidden />
      <div className="scanline-sweep" aria-hidden />
      <div className="hero-wrap" aria-hidden>
        <div className="flyer echo echo4"><div className="core" /></div>
        <div className="flyer echo echo3"><div className="core" /></div>
        <div className="flyer echo echo2"><div className="core" /></div>
        <div className="flyer echo echo1"><div className="core" /></div>
        <div className="flyer">
          <div className="core" />
          <div className="ring" />
        </div>
        <div className="burst" />
      </div>
    </>
  );
}