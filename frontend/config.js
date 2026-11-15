// Where Luminite gets its data.
//
// dataUrl: the folder that holds meta.json and the Parquet products written by
//   tools/build_web_data.py, for example
//   "https://huggingface.co/datasets/<user>/burnline-web/resolve/main".
//   Leave it empty to use the FastAPI server that serves this page.
// googleMapsKey: optional browser key for the Google 3D basemap. It is public
//   to every visitor, so restrict it to this site in Google Cloud.
export default {
  dataUrl: "",
  googleMapsKey: "",
};
