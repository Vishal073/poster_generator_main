const DEFAULT_TEXT_LINE_STYLES = [
  { fontSize: 70, fontFamily: "Helvetica Neue", fontColor: "#1f1f1f", fontWeight: "600" },
  { fontSize: 45, fontFamily: "Helvetica Neue", fontColor: "#2f2f2f", fontWeight: "500" },
  { fontSize: 30, fontFamily: "Avenir Next", fontColor: "#3a3a3a", fontWeight: "normal" },
];

const DEFAULT_LAYOUT = {
  language: "en",
  insetFromBottom: 150,
  insetLeft: 40,
  insetRight: 40,
  imagePosition: "left",
  imageWidth: 300,
  imageHeight: 300,
  imageShape: "circle",
  imageCornerRadius: 16,
  imageGap: 16,
  imageMaxSize: 350,
  lineGap: 0,
  lineGaps: [16, 16],
  fontSize: 40,
  fontColor: "#2a2a2a",
  fontFamily: "Helvetica Neue",
  textOpacity: 1,
  textBlendMode: "source-over",
  textBlockAlign: "left",
  textLineAlignments: ["left", "left", "left"],
};

const DEFAULT_FACEBOOK = {
  uploadToFacebook: false,
  uploadToInstagram: false,
  uploadToFacebookStory: false,
  uploadToInstagramStory: false,
  sendWhatsApp: true,
  facebookCaption: "",
  instagramCaption: "",
};

function getDefaultPosterConfig() {
  return {
    textLineStyles: DEFAULT_TEXT_LINE_STYLES.map((style) => ({ ...style })),
    layout: { ...DEFAULT_LAYOUT, lineGaps: [...DEFAULT_LAYOUT.lineGaps], textLineAlignments: [...DEFAULT_LAYOUT.textLineAlignments] },
    includeUserImage: true,
    addWatermark: true,
    showPhoneIcon: true,
    watermarkPosition: "top-right",
    facebook: { ...DEFAULT_FACEBOOK },
  };
}

module.exports = {
  DEFAULT_TEXT_LINE_STYLES,
  DEFAULT_LAYOUT,
  DEFAULT_FACEBOOK,
  getDefaultPosterConfig,
};
