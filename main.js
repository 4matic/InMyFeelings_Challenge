const stats = new Stats();

const isAndroid = () => /Android/i.test(navigator.userAgent);
const isiOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);
const isMobile = () => isAndroid() || isiOS();

let currentElement,
  net,
  isStopped = true,
  canvasWidth, canvasHeight, color = '#00ffff', multiTrigger, singleTrigger;

const mediaSource = new MediaSource();
mediaSource.addEventListener('sourceopen', handleSourceOpen, false);

function handleSourceOpen(event) {
  console.log('MediaSource opened');
  sourceBuffer = mediaSource.addSourceBuffer('video/webm; codecs="vp8"');
  console.log('Source buffer: ', sourceBuffer);
}

function handleDataAvailable(event) {
  if (event.data && event.data.size > 0) {
    recordedBlobs.push(event.data);
  }
}

function handleStop(event) {
  console.log('Recorder stopped: ', event);
  const superBuffer = new Blob(recordedBlobs, {type: 'video/webm'});
  // video.src = window.URL.createObjectURL(superBuffer);
}

let mediaRecorder;
let recordedBlobs;
let sourceBuffer;

const guiState = {
  algorithm: 'single-pose',
  input: {
    mobileNetArchitecture: isMobile() ? '0.50' : '1.01',
    outputStride: 16,
    imageScaleFactor: 0.5,
  },
  singlePoseDetection: {
    minPoseConfidence: 0.1,
    minPartConfidence: 0.5,
  },
  multiPoseDetection: {
    maxPoseDetections: 2,
    minPoseConfidence: 0.1,
    minPartConfidence: 0.3,
    nmsRadius: 20.0,
  },
  output: {
    showVideo: true,
    showSkeleton: true,
    showPoints: true,
  },
  net: null,
};

/**
 * Sets up dat.gui controller on the top-right of the window
 */
const setupGui = (cameras, net) => {
  guiState.net = net;

  if (cameras.length > 0) {
    guiState.camera = cameras[0].deviceId;
  }

  const cameraOptions = cameras.reduce((result, { label, deviceId }) => {
    result[label] = deviceId;
    return result;
  }, {});

  const gui = new dat.GUI({
    width: isMobile() ? 200: 300,
    closeOnTop: isMobile(),
    closed: isMobile(),
  });

  // The single-pose algorithm is faster and simpler but requires only one person to be
  // in the frame or results will be innaccurate. Multi-pose works for more than 1 person
  const algorithmController = gui.add(
    guiState, 'algorithm', ['single-pose', 'multi-pose']).listen();

  // The input parameters have the most effect on accuracy and speed of the network
  let input = gui.addFolder('Input');
  // Architecture: there are a few PoseNet models varying in size and accuracy. 1.01
  // is the largest, but will be the slowest. 0.50 is the fastest, but least accurate.
  const architectureController =
    input.add(guiState.input, 'mobileNetArchitecture', ['1.01', '1.00', '0.75', '0.50']);
  // Output stride:  Internally, this parameter affects the height and width of the layers
  // in the neural network. The lower the value of the output stride the higher the accuracy
  // but slower the speed, the higher the value the faster the speed but lower the accuracy.
  input.add(guiState.input, 'outputStride', [8, 16, 32]);
  // Image scale factor: What to scale the image by before feeding it through the network.
  input.add(guiState.input, 'imageScaleFactor').min(0.2).max(1.0);
  input.open();

  // Pose confidence: the overall confidence in the estimation of a person's
  // pose (i.e. a person detected in a frame)
  // Min part confidence: the confidence that a particular estimated keypoint
  // position is accurate (i.e. the elbow's position)
  singleTrigger = gui.addFolder('Single Pose Detection');
  singleTrigger.add(guiState.singlePoseDetection, 'minPoseConfidence', 0.0, 1.0);
  singleTrigger.add(guiState.singlePoseDetection, 'minPartConfidence', 0.0, 1.0);
  singleTrigger.open();

  multiTrigger = gui.addFolder('Multi Pose Detection');
  multiTrigger.add(
    guiState.multiPoseDetection, 'maxPoseDetections').min(1).max(20).step(1).listen();
  multiTrigger.add(guiState.multiPoseDetection, 'minPoseConfidence', 0.0, 1.0);
  multiTrigger.add(guiState.multiPoseDetection, 'minPartConfidence', 0.0, 1.0);
  // nms Radius: controls the minimum distance between poses that are returned
  // defaults to 20, which is probably fine for most use cases
  multiTrigger.add(guiState.multiPoseDetection, 'nmsRadius').min(0.0).max(40.0);

  let output = gui.addFolder('Output');
  output.add(guiState.output, 'showVideo').listen();
  output.add(guiState.output, 'showSkeleton').listen();
  output.add(guiState.output, 'showPoints');
  output.open();

  if(isMobile()) {
    gui.close();
  }

  architectureController.onChange(function (architecture) {
    guiState.changeToArchitecture = architecture;
  });

  algorithmController.onChange(function (value) {
    switch (guiState.algorithm) {
      case 'single-pose':
        multiTrigger.close();
        singleTrigger.open();
        break;
      case 'multi-pose':
        singleTrigger.close();
        multiTrigger.open();
        break;
    }
  });
};

/**
 * Sets up a frames per second panel on the top-left of the window
 */
const setupFPS = () => {
  stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
  document.body.appendChild(stats.dom);
};

const downloadVideo = (name) => {
  const blob = new Blob(recordedBlobs, {type: 'video/webm'});
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = `${name}.webm`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }, 100);
};

/**
 * Feeds an image to posenet to estimate poses - this is where the magic happens.
 * This function loops with a requestAnimationFrame method.
 */
function detectPoseInRealTime(element, net) {
  const canvas = document.getElementById('output');
  const ctx = canvas.getContext('2d');
  const flipHorizontal = true; // since images are being fed from a webcam
  canvasWidth = element.clientWidth;
  canvasHeight = element.clientHeight;

  element.width = canvasWidth;
  element.height = canvasHeight;
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  async function poseDetectionFrame() {
    if (guiState.changeToArchitecture) {
      // Important to purge variables and free up GPU memory
      guiState.net.dispose();

      // Load the PoseNet model weights for either the 0.50, 0.75, 1.00, or 1.01 version
      guiState.net = await posenet.load(Number(guiState.changeToArchitecture));

      guiState.changeToArchitecture = null;
    }

    // Begin monitoring code for frames per second
    stats.begin();

    // Scale an image down to a certain factor. Too large of an image will slow down
    // the GPU
    const imageScaleFactor = guiState.input.imageScaleFactor;
    const outputStride = Number(guiState.input.outputStride);

    let poses = [];
    let minPoseConfidence;
    let minPartConfidence;
    switch (guiState.algorithm) {
      case 'single-pose':
        const pose = await guiState.net.estimateSinglePose(element, imageScaleFactor, flipHorizontal, outputStride);
        poses.push(pose);

        minPoseConfidence = Number(
          guiState.singlePoseDetection.minPoseConfidence);
        minPartConfidence = Number(
          guiState.singlePoseDetection.minPartConfidence);
        break;
      case 'multi-pose':
        poses = await guiState.net.estimateMultiplePoses(element, imageScaleFactor, flipHorizontal, outputStride,
          guiState.multiPoseDetection.maxPoseDetections,
          guiState.multiPoseDetection.minPartConfidence,
          guiState.multiPoseDetection.nmsRadius);

        minPoseConfidence = Number(guiState.multiPoseDetection.minPoseConfidence);
        minPartConfidence = Number(guiState.multiPoseDetection.minPartConfidence);
        break;
    }

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    if (guiState.output.showVideo) {
      ctx.save();
      ctx.scale(-1, 1);
      ctx.translate(-canvasWidth, 0);
      ctx.drawImage(element, 0, 0, canvasWidth, canvasHeight);
      ctx.restore();
    }

    const scale = 1;

    // For each pose (i.e. person) detected in an image, loop through the poses
    // and draw the resulting skeleton and keypoints if over certain confidence
    // scores
    poses.forEach(({ score, keypoints }) => {
      if (score >= minPoseConfidence) {
        if (guiState.output.showPoints) {
          drawKeypoints(keypoints, minPartConfidence, ctx, color, scale);
        }
        if (guiState.output.showSkeleton) {
          drawSkeleton(keypoints, minPartConfidence, ctx, color, scale);
        }
      }
    });

    // End monitoring code for frames per second
    stats.end();

    if(!isStopped && currentElement.localName === 'video') {
      requestAnimationFrame(poseDetectionFrame);
    }
  }

  poseDetectionFrame();
}

const stopRecording = () => {
  mediaRecorder.stop();
  console.log('Recorded Blobs: ', recordedBlobs);
  // video.controls = true;
};

const startRecording = () => {
  let options = {mimeType: 'video/webm'};
  recordedBlobs = [];
  try {
    mediaRecorder = new MediaRecorder(stream, options);
  } catch (e0) {
    console.log('Unable to create MediaRecorder with options Object: ', e0);
    try {
      options = {mimeType: 'video/webm,codecs=vp9'};
      mediaRecorder = new MediaRecorder(stream, options);
    } catch (e1) {
      console.log('Unable to create MediaRecorder with options Object: ', e1);
      try {
        options = 'video/vp8'; // Chrome 47
        mediaRecorder = new MediaRecorder(stream, options);
      } catch (e2) {
        alert('MediaRecorder is not supported by this browser.\n\n' +
          'Try Firefox 29 or later, or Chrome 47 or later, ' +
          'with Enable experimental Web Platform features enabled from chrome://flags.');
        console.error('Exception while creating MediaRecorder:', e2);
        return;
      }
    }
  }
  console.log('Created MediaRecorder', mediaRecorder, 'with options', options);
  // recordButton.textContent = 'Stop Recording';
  // playButton.disabled = true;
  // downloadButton.disabled = true;
  mediaRecorder.onstop = handleStop;
  mediaRecorder.ondataavailable = handleDataAvailable;
  mediaRecorder.start(100); // collect 100ms of data
  console.log('MediaRecorder started', mediaRecorder);
};

jQuery(document).ready(function($){
  const $fileInput = $('#upload-file');
  const $giphyLink = $('#giphy-link');
  const $previewImage = $('#preview-image');
  const $previewVideo = $('#preview-video');
  const $submitForm = $('.submit-form');
  const $previewContainer = $('.preview');
  const $output = $('#output');
  const $colorpicker = $('#colorpicker');

  $fileInput.change((event) => {
    event.preventDefault();
    $('#download-btn').attr('disabled', true);
    const file = event.target.files[0];
    preprocessFile(file);
    $previewContainer.find('.title').text('Preview');
    $giphyLink.parent().find('.invalid-feedback').remove();
  });

  $colorpicker.change((event) => {
    event.preventDefault();
    color = event.target.value;
  });

  $giphyLink.change(async (event) => {
    try {
      $('#download-btn').attr('disabled', true);
      $giphyLink.parent().find('.invalid-feedback').remove();
      event.preventDefault();
      const link = event.target.value;
      if(link) {
        const file = await downloadFile(link)
        const urlCreator = window.URL || window.webkitURL;
        const fileBlob = urlCreator.createObjectURL(file);
        $previewContainer.find('.title').text('Preview');
        try {
          const resource = await showPreview(fileBlob, file.type);
          $submitForm.find('[type="submit"]').removeAttr('disabled');
          $previewContainer.show();
        } catch(err) {
          console.error(err);
          $submitForm.find('[type="submit"]').attr('disabled', true);
        }
      }
    } catch (err) {
      $giphyLink.parent().append('<div class="invalid-feedback">Failed to load resource, try another one. See developer console for more details.</div>')
    }
  });

  const playAndDownloadVideo = (type, name) => {
    if(type === 'skeleton') {
      guiState.output.showVideo = false;
      guiState.output.showSkeleton = true;
    } else if(type === 'skeleton-original') {
      guiState.output.showVideo = true;
      guiState.output.showSkeleton = true;
    }
    $previewVideo.removeAttr('loop');
    const video = $previewVideo[0];
    video.pause();
    video.load();
    video.oncanplaythrough = () => {
      $previewVideo[0].play();
      const canvas = document.getElementById('output');
      stream = canvas.captureStream(); // frames per second
      console.log('Started stream capture from canvas element: ', stream);
      startRecording();
      video.oncanplaythrough = null;
    };
    video.onended = () => {
      stopRecording();
      downloadVideo(name);
      video.onended = null;
    };
  };

  $('.download-skeleton').on('click', (e) => {
    e.preventDefault();
    playAndDownloadVideo('skeleton', 'pose-estimation-skeleton' + (guiState.algorithm === 'multi-pose' ? '-multi' : ''));
  });
  $('.download-skeleton-original').on('click', (e) => {
    e.preventDefault();
    playAndDownloadVideo('skeleton-original', 'pose-estimation' + (guiState.algorithm === 'multi-pose' ? '-multi' : ''));
  });
  $('.try-link').on('click', (e) => {
    e.preventDefault();
    const el = e.target;
    const href = el.href;
    if(href) {
      isStopped = true;
      $giphyLink.val(href);
      $giphyLink.change();
      $submitForm.find('[type="submit"]').attr('disabled', true);
      if(el.dataset && el.dataset.pose) {
        guiState.algorithm = `${el.dataset.pose}-pose`
        if(el.dataset.pose === 'multi') {
          guiState.multiPoseDetection.maxPoseDetections = 3;
          multiTrigger.open();
          singleTrigger.close();
        } else {
          multiTrigger.close();
          singleTrigger.open();
        }
      }
    }
  });

  $submitForm.on('submit', (event) => {
    event.preventDefault();
    if(currentElement) {
      // $previewContainer.hide();
      $output.parent().show();

      if (currentElement.localName === 'video') {
        currentElement.onpause = function() {
          console.log("The video has been paused");
        };
        currentElement.onstalled = function() {
          console.log("The video has been onstalled");
        };
        currentElement.play();
        setTimeout(() => {
          $('#download-btn').removeAttr('disabled');
        }, 300)
      }
      isStopped = false;

      $previewContainer.find('.title').text('Pose estimation');

      currentElement.width = undefined;
      currentElement.height = undefined;
      detectPoseInRealTime(currentElement, net);
    } else {
      $submitForm.prepend('<div class="alert alert-danger">Choose file or specify URL first!</div>')
    }
  });

  const downloadFile = (link) => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", link);
      xhr.responseType = "blob";
      xhr.onload = (event) => {
        const blob = event.target.response;
        console.log('event.target', event.target)
        resolve(blob);
      };
      xhr.onerror = (event) => {
        console.error('event', event)
        reject(event);
      };
      xhr.send();
    });
  };

  const showPreview = (blob, type) => {
    return new Promise((resolve, reject) => {
      $previewImage.parent().hide();
      $previewVideo.parent().hide();
      if(type.startsWith("image/")) {
        $previewImage.attr('src', blob);
        $previewImage.parent().show();
        currentElement = $previewImage[0];
        // $previewContainer.show();
        resolve(currentElement);
      } else if(type.startsWith("video/")) {
        const $source = $previewVideo.find('source');
        const video = $previewVideo[0];
        video.oncanplay = () =>  {
          console.log('can play video')
          video.oncanplay = null;
          $previewVideo.parent().show();
          currentElement = video;
          resolve(video)
        };
        video.onerror = (event) =>  {
          video.onerror = null;
          reject(event)
        };
        video.onabort = (event) =>  {
          video.onabort = null;
          reject(event)
        };
        // video.onsuspend = (event) =>  {
        //   video.onsuspend = null;
        //   reject(event)
        // };
        video.onstalled = (event) =>  {
          video.onstalled = null;
          reject(event)
        };
        if(!$source.length) {
          $('<source/>', {
            src: blob,
          }).appendTo($previewVideo);
        } else {
          video.onabort = null;
          video.pause();
          $source.attr('src', blob);
          video.load();
        }
      }
    });
  };

  const preprocessFile = (file) => {
    const reader = new FileReader();
    reader.addEventListener("load", async () => {
      try {
        const resource = await showPreview(reader.result, file.type);
        if(resource.localName === 'video') {
          $('#download-btn').attr('disabled', true);
        }
        $submitForm.find('[type="submit"]').removeAttr('disabled');
        $previewContainer.show();
      } catch(err) {
        console.error(err);
        $submitForm.find('[type="submit"]').attr('disabled', true);
      }
    }, false);
    if (file) {
      reader.readAsDataURL(file);
    }
  };
  const setup = async () => {
    if(isMobile()) {
      $('body').addClass('mobile');
    }
    // Load the PoseNet model weights for version 1.01
    net = await posenet.load();
    setupGui([], net);
    setupFPS();
  };
  setup();
});


